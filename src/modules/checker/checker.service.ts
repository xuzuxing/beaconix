import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../infra/database/prisma.service';
import {
    CheckSource,
    ExecutionStatus,
    ExecutionTrigger,
    MonitorType,
} from '../../generated/prisma/enums';
import type { MonitorModel } from '../../generated/prisma/models';
import type { InputJsonValue } from '../../generated/prisma/internal/prismaNamespace';
import type { Prisma } from '../../generated/prisma/client';
import { StateService } from '../state/state.service';
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

/** Rule-tree verdict for one check round: matched = abnormal. */
interface RuleOutcome {
    ruleMatched: boolean;
    ruleGroupIds: string[];
    ruleEvidence?: Prisma.InputJsonValue[];
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
        const monitors = await this.prisma.monitor.findMany({
            where: {
                organizationId,
                target: report.target,
                deletedAt: null,
                enabled: true,
            },
        });

        if (monitors.length !== 1) return null;

        return this.ingestProbeReportForMonitor(monitors[0].id, report);
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
            where: {
                monitorId: monitor.id,
                source: CheckSource.LOCAL,
                configRevision: monitor.configRevision,
            },
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
                success: localLog.localSuccess ?? localLog.success,
                latency: localLog.latency,
                error: localLog.error,
                checkedAt: report.checkedAt ?? new Date(),
                statusCode: report.statusCode ?? localLog.statusCode ?? null,
                configRevision: report.configRevision,
                observationId: report.observationId,
                probeResultId: report.probeResultId,
                serviceVerdict:
                    (localLog.localServiceVerdict as CheckResult['serviceVerdict']) ??
                    (localLog.sslVerdict === 'INVALID'
                        ? 'NO_EVIDENCE'
                        : localLog.sslVerdict &&
                            ['EXPIRING', 'EXPIRED'].includes(
                                localLog.sslVerdict,
                            )
                          ? 'SUCCESS'
                          : (localLog.localSuccess ?? localLog.success)
                            ? 'SUCCESS'
                            : 'FAILURE'),
                sslVerdict:
                    (localLog.sslVerdict as CheckResult['sslVerdict']) ??
                    undefined,
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

        // Rule tree only produces a verdict (matched = abnormal); it is stored
        // on the CheckLog row below, then the availability alert consumes it.
        const ruleOutcome = await this.evaluateRuleTree(monitor, result);

        const { transition, deliveries } = await this.stateService.record(
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
                statusCode:
                    source === CheckSource.LOCAL
                        ? (localResult.statusCode ?? null)
                        : (result.statusCode ?? null),
                configRevision:
                    reported?.configRevision ?? monitor.configRevision,
                observationId: reported?.observationId,
                probeResultId: reported?.probeResultId,
                serviceVerdict:
                    result.serviceVerdict ?? localResult.serviceVerdict,
                localServiceVerdict: localResult.serviceVerdict,
                sslVerdict:
                    source === CheckSource.LOCAL
                        ? localResult.sslVerdict
                        : 'NO_EVIDENCE',
                failureReason: localResult.failureReason,
                ruleMatched: ruleOutcome.ruleMatched,
                ruleGroupIds: ruleOutcome.ruleGroupIds,
                ruleEvidence: ruleOutcome.ruleEvidence,
                probeRoundWindowMs:
                    source === CheckSource.PROBE
                        ? probeReportDedupWindowMs(monitor.interval)
                        : undefined,
            },
        );

        // Alert condition: aggregate the stored rule verdicts into an
        // availability percentage and consecutive-failure count, then alert
        // when both cross their thresholds. Runs before the transition
        // notification.
        const notified = {
            skipped: !deliveries,
            sent: deliveries ?? 0,
            failed: 0,
        };

        await this.writeExecution(monitor, result, trigger, {
            previousStatus: transition.previousStatus,
            status: transition.status,
            changed: transition.changed,
            ruleGroupIds: ruleOutcome.ruleGroupIds,
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
        const certificatePolicyFailure =
            localResult.ssl !== undefined ||
            !!(
                localResult.sslVerdict &&
                localResult.sslVerdict !== 'NO_EVIDENCE'
            );
        if (
            certificatePolicyFailure &&
            (localResult.serviceVerdict === 'SUCCESS' || localResult.ssl)
        ) {
            return { result: localResult, rescuedByProbe: false };
        }

        const since = new Date(
            Date.now() - probeResultWindowMs(monitor.interval),
        );
        const tenantProbeResults = await this.prisma.probeResult.findMany({
            where: {
                target: monitor.target,
                monitorId: monitor.id,
                checkedAt: { gte: since },
                configRevision: monitor.configRevision,
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
                          monitorId: monitor.id,
                          probeId: { in: systemProbeIds },
                          checkedAt: { gte: since },
                          configRevision: monitor.configRevision,
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
            if (certificatePolicyFailure) {
                return {
                    result: { ...localResult, serviceVerdict: 'SUCCESS' },
                    rescuedByProbe: false,
                };
            }
            return {
                result: {
                    success: true,
                    latency: localResult.latency,
                    error: null,
                    checkedAt: localResult.checkedAt,
                    serviceVerdict: 'SUCCESS',
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
     * Evaluates the monitor's bound rule groups against the aggregated verdict
     * and returns the round's verdict: `ruleMatched` (any group matched) plus
     * the IDs of the groups that did. Monitors without any bound rule group
     * fall back to `!success`, so reachability failures still count as abnormal.
     * Never throws: a failed evaluation only logs and falls back.
     */
    private async evaluateRuleTree(
        monitor: MonitorModel,
        result: CheckResult,
    ): Promise<RuleOutcome> {
        try {
            const bindings = await this.ruleGroups.findBindingsForMonitor(
                monitor.id,
            );

            if (bindings.length === 0) {
                return { ruleMatched: !result.success, ruleGroupIds: [] };
            }

            const ctx = this.buildRuleContext(result);
            const ruleGroupIds: string[] = [];
            const ruleEvidence: Prisma.InputJsonValue[] = [];

            for (const binding of bindings) {
                const matched = this.ruleEvaluator.evaluate(
                    binding.ruleGroup.tree as unknown as RuleNode,
                    ctx,
                );
                if (matched) ruleGroupIds.push(binding.ruleGroupId);
                if (matched)
                    ruleEvidence.push({
                        groupId: binding.ruleGroupId,
                        reason: binding.ruleGroup.fieldsUsed?.includes(
                            'latency',
                        )
                            ? 'SLOW_RESPONSE'
                            : 'RULE_MATCHED',
                        conditions: JSON.parse(
                            JSON.stringify(
                                this.ruleEvaluator.explain(
                                    binding.ruleGroup
                                        .tree as unknown as RuleNode,
                                    ctx,
                                ),
                            ),
                        ) as Prisma.InputJsonValue,
                    });
            }

            return {
                ruleMatched: ruleGroupIds.length > 0,
                ruleGroupIds,
                ruleEvidence,
            };
        } catch (error) {
            this.logger.warn(
                `Rule evaluation failed for monitor ${monitor.id}: ${(error as Error).message}`,
            );
            return { ruleMatched: !result.success, ruleGroupIds: [] };
        }
    }
}
