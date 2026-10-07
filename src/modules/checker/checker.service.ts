import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../infra/database/prisma.service';
import {
    CheckSource,
    ExecutionStatus,
    ExecutionTrigger,
    MonitorStatus,
    MonitorType,
    RuleAction,
} from '../../generated/prisma/enums';
import type {
    MonitorModel,
    MonitorStateModel,
} from '../../generated/prisma/models';
import type { InputJsonValue } from '../../generated/prisma/internal/prismaNamespace';
import { StateService } from '../state/state.service';
import type { MonitorTransition } from '../state/state.service';
import { NotifierService } from '../notifier/notifier.service';
import type { NotificationResult } from '../notifier/notifier.service';
import { SystemProbeScheduler } from '../admin/system-probes/system-probe-scheduler';
import { RuleEvaluatorService } from '../rules/rule-evaluator.service';
import { RuleGroupsService } from '../rules/rule-groups.service';
import type { RuleContext, RuleNode } from '../rules/types';
import { HttpChecker, TcpChecker } from './checkers';
import type { CheckResult, ProbeReport } from './checkers';
import { QueryCheckLogsDto } from './dto';
import { CheckLogEntity } from './entities';
import { MONITOR_CHECK_DEDUP_PREFIX, MONITOR_CHECK_JOB } from './checker.queue';
import type { MonitorCheckJobData } from './checker.queue';

const PROBE_RESULT_WINDOW_INTERVALS = 2;
const PROBE_RESULT_MIN_WINDOW_MS = 2 * 60 * 1000;
const PROBE_RESULT_MAX_WINDOW_MS = 15 * 60 * 1000;

/**
 * How long a probe report stays usable when the local check failed. It scales
 * with the monitor interval - a 5 minute monitor cannot be judged by probes
 * that also report every 5 minutes if we only look back 2 minutes - but stays
 * bounded so an ancient report never decides for a long interval.
 */
export function probeResultWindowMs(intervalSeconds: number): number {
    const scaled = intervalSeconds * 1000 * PROBE_RESULT_WINDOW_INTERVALS;

    return Math.min(
        Math.max(scaled, PROBE_RESULT_MIN_WINDOW_MS),
        PROBE_RESULT_MAX_WINDOW_MS,
    );
}

const PROBE_REPORT_DEDUP_MIN_MS = 5 * 1000;
const PROBE_REPORT_DEDUP_MAX_MS = 30 * 1000;
const PROBE_REPORT_DEDUP_INTERVALS = 4;

/**
 * Probe reports for the same monitor arriving closer together than this are
 * treated as one round and folded into the state only once: several probes can
 * cover the same target, and an agent that restarted reports again immediately.
 *
 * The window is a fraction of the monitor interval and stays well below it, so a
 * probe reporting on its own schedule is never suppressed. Raw rows still land in
 * `probe_results`, so a later local check still sees the full picture.
 */
export function probeReportDedupWindowMs(intervalSeconds: number): number {
    const scaled = (intervalSeconds * 1000) / PROBE_REPORT_DEDUP_INTERVALS;

    return Math.min(
        Math.max(scaled, PROBE_REPORT_DEDUP_MIN_MS),
        PROBE_REPORT_DEDUP_MAX_MS,
    );
}

export interface CheckExecution extends CheckResult {
    monitorId: string;
    previousStatus: string;
    status: string;
    changed: boolean;
    notified: NotificationResult;
}

/** A monitor plus the state fields the due check needs. */
export type DueMonitor = MonitorModel & {
    state?: { lastLocalCheckAt: Date | null } | null;
};

/** The aggregated verdict plus whether a probe overrode a local failure. */
interface EvaluatedResult {
    result: CheckResult;
    rescuedByProbe: boolean;
}

/** Actions a matched rule group requests for the current check round. */
interface RuleEffects {
    /** A SILENCE rule matched: suppress this round's notifications. */
    silenced: boolean;
    /** A MARK_DOWN rule matched: force the monitor status to DOWN. */
    markDown: boolean;
}

@Injectable()
export class CheckerService {
    private readonly logger = new Logger(CheckerService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly stateService: StateService,
        private readonly notifierService: NotifierService,
        private readonly httpChecker: HttpChecker,
        private readonly tcpChecker: TcpChecker,
        private readonly systemProbeScheduler: SystemProbeScheduler,
        private readonly ruleEvaluator: RuleEvaluatorService,
        private readonly ruleGroups: RuleGroupsService,
    ) {}

    /** Runs a check for one monitor of a project (tenant-scoped entry). */
    async checkMonitorForProject(
        projectId: string,
        monitorId: string,
    ): Promise<CheckExecution> {
        const monitor = await this.prisma.monitor.findFirst({
            where: { id: monitorId, projectId, deletedAt: null },
        });

        if (!monitor) {
            throw new NotFoundException('Monitor not found');
        }

        return this.execute(
            monitor,
            CheckSource.LOCAL,
            undefined,
            ExecutionTrigger.MANUAL,
        );
    }

    /**
     * Applies a probe-reported result to the monitor that owns `target`.
     * Returns null when no monitor of the organization matches the target.
     */
    async ingestProbeReport(
        organizationId: string,
        report: ProbeReport,
    ): Promise<CheckExecution | null> {
        const monitor = await this.prisma.monitor.findFirst({
            where: {
                organizationId,
                target: report.target,
                deletedAt: null,
                enabled: true,
            },
        });

        if (!monitor) return null;

        return this.ingestProbeReportForMonitor(monitor.id, report);
    }

    async ingestProbeReportForMonitor(
        monitorId: string,
        report: ProbeReport,
    ): Promise<CheckExecution | null> {
        const monitor = await this.prisma.monitor.findFirst({
            where: {
                id: monitorId,
                target: report.target,
                deletedAt: null,
                enabled: true,
            },
        });

        if (!monitor) return null;

        const localLog = await this.prisma.checkLog.findFirst({
            where: { monitorId: monitor.id, source: CheckSource.LOCAL },
            orderBy: { checkedAt: 'desc' },
        });

        if (!localLog) return null;

        // Reports inside one round are folded once. The raw ProbeResult rows are
        // already stored, so the next local check still aggregates all of them -
        // only the duplicated CheckLog row and state transition are skipped.
        const lastProbeLog = await this.prisma.checkLog.findFirst({
            where: { monitorId: monitor.id, source: CheckSource.PROBE },
            orderBy: { checkedAt: 'desc' },
            select: { checkedAt: true },
        });

        if (
            lastProbeLog &&
            Date.now() - lastProbeLog.checkedAt.getTime() <
                probeReportDedupWindowMs(monitor.interval)
        ) {
            return null;
        }

        return this.execute(
            monitor,
            CheckSource.PROBE,
            {
                success: localLog.success,
                latency: localLog.latency,
                error: localLog.error,
                checkedAt: report.checkedAt ?? new Date(),
                statusCode:
                    report.statusCode ?? localLog.statusCode ?? null,
            },
            ExecutionTrigger.CALLBACK,
        );
    }

    /**
     * Monitors that are enabled and whose interval elapsed since the last
     * recorded check.
     */
    async findDueMonitors(): Promise<DueMonitor[]> {
        const monitors = await this.prisma.monitor.findMany({
            where: { enabled: true, deletedAt: null },
            include: { state: { select: { lastLocalCheckAt: true } } },
        });

        return monitors.filter((monitor) =>
            this.isDue(
                monitor.interval,
                monitor.state?.lastLocalCheckAt ?? null,
            ),
        );
    }

    /**
     * Scans the due monitors and enqueues one check job per monitor, so the
     * scan itself stays fast no matter how slow a target is. A monitor whose
     * previous job is still waiting or active is skipped instead of queued
     * twice. Returns how many monitors were due and how many jobs were added.
     */
    async enqueueDueChecks(
        queue: Queue<MonitorCheckJobData>,
    ): Promise<{ due: number; enqueued: number }> {
        const due = await this.findDueMonitors();
        let enqueued = 0;

        await Promise.all(
            due.map(async (monitor) => {
                try {
                    await queue.add(
                        MONITOR_CHECK_JOB,
                        { monitorId: monitor.id },
                        {
                            // No TTL: BullMQ releases the key when the job
                            // finalizes, which is exactly "skip while running".
                            deduplication: {
                                id: `${MONITOR_CHECK_DEDUP_PREFIX}:${monitor.id}`,
                            },
                            removeOnComplete: true,
                            removeOnFail: 100,
                        },
                    );
                    enqueued += 1;
                } catch (error) {
                    this.logger.warn(
                        `Failed to enqueue check for monitor ${monitor.id}: ${(error as Error).message}`,
                    );
                }
            }),
        );

        return { due: due.length, enqueued };
    }

    /**
     * Runs the local check of a single monitor. The monitor is re-read so a job
     * queued before it was paused or deleted becomes a no-op.
     */
    async executeMonitor(monitorId: string): Promise<CheckExecution | null> {
        const monitor = await this.prisma.monitor.findFirst({
            where: { id: monitorId, enabled: true, deletedAt: null },
        });

        if (!monitor) return null;

        return this.execute(
            monitor,
            CheckSource.LOCAL,
            undefined,
            ExecutionTrigger.SCHEDULED,
        );
    }

    /** Paginated check history of one monitor. */
    async listCheckLogs(
        projectId: string,
        monitorId: string,
        query: QueryCheckLogsDto,
    ) {
        const monitor = await this.prisma.monitor.findFirst({
            where: { id: monitorId, projectId, deletedAt: null },
            select: { id: true },
        });

        if (!monitor) {
            throw new NotFoundException('Monitor not found');
        }

        const page = query.page ?? 1;
        const limit = query.limit ?? 20;
        const skip = (page - 1) * limit;

        const where: Record<string, unknown> = { monitorId };
        if (query.success !== undefined) where.success = query.success;
        if (query.source) where.source = query.source;

        const [logs, total] = await Promise.all([
            this.prisma.checkLog.findMany({
                where,
                orderBy: { checkedAt: 'desc' },
                skip,
                take: limit,
            }),
            this.prisma.checkLog.count({ where }),
        ]);

        return {
            data: logs.map((log) => new CheckLogEntity(log)),
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    // -- Internals -------------------------------------------------------

    private async execute(
        monitor: MonitorModel,
        source: CheckSource = CheckSource.LOCAL,
        reported?: CheckResult,
        trigger: ExecutionTrigger = ExecutionTrigger.SCHEDULED,
    ): Promise<CheckExecution> {
        const localResult = reported ?? (await this.probe(monitor));
        const { result, rescuedByProbe } = await this.evaluateResult(
            monitor,
            localResult,
        );

        const { state, transition } = await this.stateService.record(
            monitor.id,
            {
                success: result.success,
                latency: result.latency,
                error: result.error,
                source,
                checkedAt: result.checkedAt,
                ssl: result.ssl,
                localSuccess: localResult.success,
                rescuedByProbe,
                statusCode: result.statusCode ?? null,
            },
        );

        // Availability (simple mode) and rule-tree (advanced mode) alerting both
        // ride on the same aggregated verdict and run before the transition
        // notification, but are independent of it.
        await this.evaluateAvailabilityAlert(monitor, state);
        const ruleEffects = await this.evaluateRuleGroups(
            monitor,
            state,
            result,
        );

        // MARK_DOWN forces the monitor DOWN (the state machine recovers it on
        // the next successful check). SILENCE suppresses this round's alert.
        if (ruleEffects.markDown) {
            await this.markDownByRule(monitor.id);
        }

        const notified = ruleEffects.silenced
            ? { skipped: true, sent: 0, failed: 0 }
            : await this.notifyIfChanged(monitor, state, transition);

        await this.writeExecution(monitor, result, trigger, {
            previousStatus: transition.previousStatus,
            status: transition.status,
            changed: transition.changed,
            notified: {
                skipped: notified.skipped,
                sent: notified.sent,
                failed: notified.failed,
            },
        });

        return {
            ...result,
            monitorId: monitor.id,
            previousStatus: transition.previousStatus,
            status: transition.status,
            changed: transition.changed,
            notified,
        };
    }

    private async notifyIfChanged(
        monitor: MonitorModel,
        state: MonitorStateModel,
        transition: MonitorTransition,
    ): Promise<NotificationResult> {
        if (!transition.changed) {
            return { skipped: true, sent: 0, failed: 0 };
        }

        return this.notifierService.notifyTransition(
            monitor,
            state,
            transition,
        );
    }

    private async writeExecution(
        monitor: MonitorModel,
        result: CheckResult,
        trigger: ExecutionTrigger,
        responseMeta: InputJsonValue,
    ): Promise<void> {
        try {
            await this.prisma.probeExecution.create({
                data: {
                    probeId: null,
                    monitorId: monitor.id,
                    target: monitor.target,
                    trigger,
                    status: result.success
                        ? ExecutionStatus.SUCCESS
                        : ExecutionStatus.FAILED,
                    success: result.success,
                    latency: result.latency,
                    error: result.error,
                    requestMeta: {
                        source: CheckSource.LOCAL,
                        monitorType: monitor.type,
                    },
                    responseMeta,
                    executedAt: result.checkedAt,
                },
            });
        } catch (error) {
            this.logger.warn(
                `Failed to write execution log for monitor ${monitor.id}: ${(error as Error).message}`,
            );
        }
    }

    private async probe(monitor: MonitorModel): Promise<CheckResult> {
        if (monitor.type === MonitorType.HTTP) {
            return this.httpChecker.check(
                monitor.target,
                monitor.timeout,
                monitor.expectedStatus,
                {
                    checkSsl: monitor.checkSsl,
                    sslExpiryThreshold: monitor.sslExpiryThreshold,
                },
            );
        }

        if (monitor.type === MonitorType.TCP) {
            return this.tcpChecker.check(monitor.target, monitor.timeout);
        }

        return {
            success: false,
            latency: 0,
            error: `Unsupported monitor type "${String(monitor.type)}"`,
            checkedAt: new Date(),
        };
    }

    private async evaluateResult(
        monitor: MonitorModel,
        localResult: CheckResult,
    ): Promise<EvaluatedResult> {
        if (localResult.success) {
            return { result: localResult, rescuedByProbe: false };
        }

        // A certificate verdict is a fact about the certificate, not a
        // reachability signal, so a reachable probe must not override it.
        if (localResult.ssl !== undefined) {
            return { result: localResult, rescuedByProbe: false };
        }

        const since = new Date(
            Date.now() - probeResultWindowMs(monitor.interval),
        );
        const tenantProbeResults = await this.prisma.probeResult.findMany({
            where: {
                target: monitor.target,
                checkedAt: { gte: since },
                probe: {
                    organizationId: monitor.organizationId,
                    enabled: true,
                    status: 'ONLINE',
                    scope: 'TENANT',
                    monitors: {
                        some: { monitorId: monitor.id },
                    },
                },
            },
            orderBy: { checkedAt: 'desc' },
        });

        const systemProbeIds =
            await this.systemProbeScheduler.getAssignedProbes(monitor.id);
        const systemProbeResults =
            systemProbeIds.length > 0
                ? await this.prisma.probeResult.findMany({
                      where: {
                          target: monitor.target,
                          probeId: { in: systemProbeIds },
                          checkedAt: { gte: since },
                          probe: {
                              scope: 'SYSTEM',
                              enabled: true,
                              status: 'ONLINE',
                          },
                      },
                      orderBy: { checkedAt: 'desc' },
                  })
                : [];

        const probeResults = [...tenantProbeResults, ...systemProbeResults];

        if (probeResults.length === 0) {
            return { result: localResult, rescuedByProbe: false };
        }

        if (probeResults.some((result) => result.success)) {
            return {
                result: {
                    success: true,
                    latency: localResult.latency,
                    error: null,
                    checkedAt: localResult.checkedAt,
                },
                rescuedByProbe: true,
            };
        }

        return {
            result: {
                ...localResult,
                error: this.buildAggregatedError(
                    localResult,
                    probeResults.length,
                ),
            },
            rescuedByProbe: false,
        };
    }

    private buildAggregatedError(
        localResult: CheckResult,
        probeFailureCount: number,
    ): string {
        const localError = localResult.error ?? 'Local check failed';
        return `${localError}; all ${probeFailureCount} probe result(s) failed`;
    }

    private isDue(intervalSeconds: number, lastCheckAt: Date | null): boolean {
        if (!lastCheckAt) return true;

        return Date.now() - lastCheckAt.getTime() >= intervalSeconds * 1000;
    }

    /**
     * Applies the availability rule to a fresh check outcome.
     *
     * - the alert fires once when availability is below the threshold AND the
     *   consecutive-failure threshold is reached, then stays silent until the
     *   monitor recovers;
     * - recovery is announced once availability climbs back to the threshold.
     *
     * Alerting must never break the check pipeline: a failed enqueue or write
     * only logs, the check outcome still stands.
     */
    private async evaluateAvailabilityAlert(
        monitor: MonitorModel,
        state: MonitorStateModel,
    ): Promise<void> {
        if (!monitor.availabilityEnabled) return;

        const threshold = monitor.availabilityThreshold ?? 90;
        const window = monitor.availabilityWindow ?? 10;

        const recent = await this.prisma.checkLog.findMany({
            where: { monitorId: monitor.id },
            orderBy: { checkedAt: 'desc' },
            take: window,
            select: { success: true },
        });

        if (recent.length === 0) return;

        const successes = recent.filter((log) => log.success).length;
        const availabilityPercent =
            Math.round((successes / recent.length) * 10000) / 100;
        const alert = {
            availabilityPercent,
            threshold,
            window,
            sampleSize: recent.length,
        };

        const belowThreshold = availabilityPercent < threshold;
        const failuresReached = state.failCount >= monitor.failureThreshold;

        try {
            if (belowThreshold && failuresReached) {
                // Already alerting: stay silent so a persistent outage does
                // not re-notify on every check.
                if (state.availabilityAlertActive) return;

                await this.notifierService.notifyAvailabilityAlert(
                    monitor,
                    state,
                    alert,
                );

                await this.prisma.monitorState.update({
                    where: { monitorId: monitor.id },
                    data: {
                        availabilityAlertActive: true,
                        lastAvailabilityAlertAt: new Date(),
                    },
                });
                return;
            }

            // Availability recovered: announce it once and clear the flag.
            if (state.availabilityAlertActive) {
                await this.notifierService.notifyAvailabilityRecovery(
                    monitor,
                    state,
                    alert,
                );

                await this.prisma.monitorState.update({
                    where: { monitorId: monitor.id },
                    data: { availabilityAlertActive: false },
                });
            }
        } catch (error) {
            this.logger.warn(
                `Availability alert failed for monitor ${monitor.id}: ${(error as Error).message}`,
            );
        }
    }

    /** 构造规则求值上下文，来自聚合后的 CheckResult。 */
    private buildRuleContext(result: CheckResult): RuleContext {
        return {
            success: result.success,
            latency: result.latency,
            certDaysRemaining: result.ssl?.daysRemaining,
            statusCode: result.statusCode ?? undefined,
            bodyContains: result.bodyContains ?? undefined,
        };
    }

    /**
     * Evaluates the monitor's bound rule groups (advanced mode) against the
     * aggregated verdict. Matched ALERT bindings enqueue a rule notification.
     * Never throws: a failed evaluation only logs, the check outcome stands.
     */
    private async evaluateRuleGroups(
        monitor: MonitorModel,
        state: MonitorStateModel,
        result: CheckResult,
    ): Promise<RuleEffects> {
        const effects: RuleEffects = { silenced: false, markDown: false };

        let bindings;
        try {
            bindings = await this.ruleGroups.findBindingsForMonitor(monitor.id);
        } catch (error) {
            this.logger.warn(
                `Failed to load rule bindings for monitor ${monitor.id}: ${(error as Error).message}`,
            );
            return effects;
        }

        if (bindings.length === 0) return effects;

        const ctx = this.buildRuleContext(result);

        for (const binding of bindings) {
            try {
                const matched = this.ruleEvaluator.evaluate(
                    binding.ruleGroup.tree as RuleNode,
                    ctx,
                );
                if (!matched) continue;

                switch (binding.action) {
                    case RuleAction.ALERT:
                        await this.notifierService.notifyRuleAlert(
                            monitor,
                            state,
                            {
                                id: binding.ruleGroup.id,
                                name: binding.ruleGroup.name,
                            },
                        );
                        break;
                    case RuleAction.SILENCE:
                        effects.silenced = true;
                        break;
                    case RuleAction.MARK_DOWN:
                        effects.markDown = true;
                        break;
                }
            } catch (error) {
                this.logger.warn(
                    `Rule evaluation failed for monitor ${monitor.id}: ${(error as Error).message}`,
                );
            }
        }

        return effects;
    }

    /** Forces a monitor DOWN because a MARK_DOWN rule matched. */
    private async markDownByRule(monitorId: string): Promise<void> {
        try {
            await this.prisma.monitorState.update({
                where: { monitorId },
                data: { status: MonitorStatus.DOWN },
            });
        } catch (error) {
            this.logger.warn(
                `Failed to mark monitor ${monitorId} DOWN by rule: ${(error as Error).message}`,
            );
        }
    }
}
