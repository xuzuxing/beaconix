import { randomUUID } from 'node:crypto';
import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../infra/database/prisma.service';
import {
    CheckSource,
    ExecutionStatus,
    ExecutionTrigger,
    MonitorType,
} from '../../generated/prisma/enums';
import type {
    MonitorModel,
    MonitorStateModel,
    ProbeResultModel,
} from '../../generated/prisma/models';
import type { InputJsonValue } from '../../generated/prisma/internal/prismaNamespace';
import { Prisma } from '../../generated/prisma/client';
import { StateService } from '../state/state.service';
import type { AppliedAggregation } from '../state/state.service';
import { NotifierService } from '../notifier/notifier.service';
import type { NotificationResult } from '../notifier/notifier.service';
import { SystemProbeScheduler } from '../admin/system-probes/system-probe-scheduler';
import { RuleEvaluatorService } from '../rules/rule-evaluator.service';
import { RuleGroupsService } from '../rules/rule-groups.service';
import type { RuleContext, RuleNode } from '../rules/types';
import { CheckerRegistry } from './checker.registry';
import { QuotaService } from '../../shared/quota/quota.service';
import type { MonitorPolicy } from '../../shared/quota/quota.service';
import { capacityRestricted } from '../../shared/subscription/monitor-capacity.util';
import type {
    CheckFailureKind,
    CheckMetadata,
    CheckResult,
    ProbeReport,
} from './checkers';
import { QueryCheckLogsDto } from './dto';
import {
    CheckLogEntity,
    CheckRoundAggregationEntity,
    CheckRoundEntity,
    CheckRoundProbeEntity,
    CheckRoundProbeResultEntity,
} from './entities';
import {
    MONITOR_CHECK_DEDUP_PREFIX,
    MONITOR_CHECK_JOB,
    MONITOR_CHECK_QUEUE,
    MONITOR_SETTLE_JOB,
} from './checker.queue';
import type {
    MonitorCheckJobData,
    MonitorSettleJobData,
} from './checker.queue';
import { ProjectAccessService } from '../../common/authorization/project-access.service';
import type { AccessPrincipal } from '../../common/authorization/access.types';
import { monitoringProjection } from '../../common/authorization/monitoring-projection';

const PROBE_RESULT_WINDOW_INTERVALS = 2;
const PROBE_RESULT_MIN_WINDOW_MS = 2 * 60 * 1000;
const PROBE_RESULT_MAX_WINDOW_MS = 15 * 60 * 1000;

/** How often a batch id collision is retried before the run is dropped. */
const ROUND_ANCHOR_ATTEMPTS = 3;

/**
 * How long a probe report stays usable for a batch. It scales with the monitor
 * interval - a 5 minute monitor cannot be judged by probes that also report
 * every 5 minutes if we only look back 2 minutes - but stays bounded so an
 * ancient report never decides for a long interval.
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
 * How long probe reports for the same monitor are treated as one round. Stays
 * well below the interval, so a probe reporting on its own schedule is never
 * suppressed.
 *
 * With batches the aggregation itself is idempotent (`CheckLog.appliedAt`), so
 * this window now only bounds how long a late report may still join the open
 * batch.
 */
export function probeReportDedupWindowMs(intervalSeconds: number): number {
    const scaled = (intervalSeconds * 1000) / PROBE_REPORT_DEDUP_INTERVALS;

    return Math.min(
        Math.max(scaled, PROBE_REPORT_DEDUP_MIN_MS),
        PROBE_REPORT_DEDUP_MAX_MS,
    );
}

/** Batch id anchored at the local check start; probes join the open batch. */
export function buildRoundId(monitorId: string, startedAt: Date): string {
    return `${monitorId}:${startedAt.getTime()}`;
}

/**
 * How long after its start a batch still accepts probe reports: one interval
 * plus the fold window, so a report that arrives late is not attributed
 * retroactively.
 */
export function roundAttributionWindowMs(intervalSeconds: number): number {
    return intervalSeconds * 1000 + probeReportDedupWindowMs(intervalSeconds);
}

export interface CheckExecution extends CheckResult {
    monitorId: string;
    previousStatus: string;
    status: string;
    changed: boolean;
    notified: NotificationResult;
    applied: boolean;
}

/** A monitor plus the state fields the due check needs. */
export type DueMonitor = MonitorModel & {
    state?: { lastLocalCheckAt: Date | null } | null;
};

/** One latest valid probe observation: each probe gets at most one vote. */
type ProbeVerdictSample = Pick<
    ProbeResultModel,
    'id' | 'probeId' | 'success' | 'checkedAt' | 'receivedAt'
>;

interface ProbeVerdict {
    /** Probes that could report for this batch: online tenant + assigned system. */
    expectedProbeCount: number;
    /**
     * Reports that actually arrived for this batch - the ratio denominator.
     * Probes that never reported are dropped instead of counting as failures.
     */
    samples: ProbeVerdictSample[];
    /** How many of `samples` came from tenant probes; the rest are system. */
    tenantSampleCount: number;
}

/** Rule-tree verdict for one check round: matched = abnormal. */
interface RuleOutcome {
    ruleMatched: boolean;
    ruleGroupIds: string[];
    ruleEvidence?: Prisma.InputJsonValue[];
}

/** Why a batch cannot be judged by probes and settles with the local verdict. */
type AggregationGuards = {
    protected: boolean;
    protectedReason:
        'LEGACY_UNSUPPORTED' | 'UNEVALUATED' | 'ASSERTION' | 'SSL' | null;
};

export type SettleOutcome =
    'SETTLED' | 'DUPLICATE' | 'PENDING' | 'NOT_FOUND' | 'NOT_READY';

export interface RoundSettlement {
    outcome: SettleOutcome;
    execution: CheckExecution | null;
}

@Injectable()
export class CheckerService {
    private readonly logger = new Logger(CheckerService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly stateService: StateService,
        private readonly notifierService: NotifierService,
        private readonly registry: CheckerRegistry,
        private readonly quotaService: QuotaService,
        private readonly systemProbeScheduler: SystemProbeScheduler,
        private readonly ruleEvaluator: RuleEvaluatorService,
        private readonly ruleGroups: RuleGroupsService,
        private readonly access: ProjectAccessService,
        @Optional()
        @InjectQueue(MONITOR_CHECK_QUEUE)
        private readonly checkQueue?: Queue<
            MonitorCheckJobData | MonitorSettleJobData
        >,
    ) {}

    /** Runs a check for one monitor of a project (tenant-scoped entry). */
    async checkMonitorForProject(
        projectId: string,
        monitorId: string,
        principal: AccessPrincipal,
    ): Promise<CheckExecution> {
        const monitor = await this.access.withProject(
            principal,
            projectId,
            'monitor.check',
            async (tx, access) => {
                const monitor = await tx.monitor.findFirst({
                    where: {
                        id: monitorId,
                        projectId,
                        organizationId: access.organizationId,
                        deletedAt: null,
                    },
                });

                if (!monitor) {
                    throw new NotFoundException('Monitor not found');
                }
                if (!monitor.enabled)
                    throw new BadRequestException('Monitor is paused');
                await tx.auditLog.create({
                    data: {
                        actorId:
                            principal.type === 'USER' ? principal.userId : null,
                        organizationId: access.organizationId,
                        projectId,
                        entity: 'Monitor',
                        entityId: monitorId,
                        action: 'UPDATE',
                        after: { action: 'monitor.check' },
                    },
                });
                return monitor;
            },
        );
        await this.quotaService.assertMonitorTypeAllowed(
            monitor.organizationId,
            monitor.type,
        );
        await this.quotaService.assertIntervalAllowed(
            monitor.organizationId,
            monitor.interval,
        );
        const eligibility = await this.quotaService.monitorEligibility(
            monitor.organizationId,
            monitor.type,
            monitor.interval,
            undefined,
            monitor.id,
        );
        if (!eligibility.eligible)
            throw new ForbiddenException(
                eligibility.reason ?? 'Monitor cannot execute',
            );

        const result = await this.execute(monitor, ExecutionTrigger.MANUAL);
        const current = await this.access.project(
            principal,
            projectId,
            'monitor.read',
        );
        return monitoringProjection(result, current.effectiveRole);
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

    /**
     * Tries to settle the monitor's open batch after a probe report landed.
     *
     * The report itself is already stored as a `ProbeResult` row (with its
     * `roundId`); this path never appends a CheckLog row, it only closes the
     * batch once enough probes reported.
     */
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

        if (!monitor || !this.acceptsLegacyProbe(monitor)) return null;
        const eligibility = await this.quotaService.monitorEligibility(
            monitor.organizationId,
            monitor.type,
            monitor.interval,
            undefined,
            monitor.id,
        );
        if (!eligibility.eligible) return null;

        // The open batch is the local row that has not been settled yet.
        const open = await this.prisma.checkLog.findFirst({
            where: {
                monitorId: monitor.id,
                roundId: { not: null },
                appliedAt: null,
            },
            orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }],
        });

        if (!open?.roundId) return null;
        if (open.configRevision !== monitor.configRevision) return null;
        if (
            open.evaluated === false ||
            open.failureKind === 'ASSERTION' ||
            open.revision !== monitor.revision
        )
            return null;

        const settlement = await this.settleRound(monitor.id, open.roundId);
        return settlement.execution;
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

        const due = monitors.filter((monitor) =>
            this.isDue(
                monitor.interval,
                monitor.state?.lastLocalCheckAt ?? null,
            ),
        );
        const cache = new Map<string, Promise<MonitorPolicy>>();
        const eligibility = await Promise.all(
            due.map((monitor) => {
                const key = monitor.organizationId;
                if (!cache.has(key))
                    cache.set(key, this.quotaService.getMonitorPolicy(key));
                return cache
                    .get(key)!
                    .then((policy) =>
                        this.quotaService.monitorEligibility(
                            key,
                            monitor.type,
                            monitor.interval,
                            policy,
                            monitor.id,
                        ),
                    );
            }),
        );
        return due.filter((_, index) => eligibility[index].eligible);
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
        const eligibility = await this.quotaService.monitorEligibility(
            monitor.organizationId,
            monitor.type,
            monitor.interval,
            undefined,
            monitor.id,
        );
        if (!eligibility.eligible) return null;

        return this.execute(monitor, ExecutionTrigger.SCHEDULED);
    }

    /** Paginated check history of one monitor. */
    async listCheckLogs(
        projectId: string,
        monitorId: string,
        query: QueryCheckLogsDto,
        principal: AccessPrincipal,
    ) {
        const access = await this.access.project(
            principal,
            projectId,
            'monitor.read',
        );
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

        const where: Record<string, unknown> = {
            monitorId,
            projectId,
            organizationId: access.organizationId,
        };
        if (query.success !== undefined) where.success = query.success;
        if (query.source) where.source = query.source;
        if (query.roundId) where.roundId = query.roundId;

        const [logs, total] = await Promise.all([
            this.prisma.checkLog.findMany({
                where,
                orderBy: { checkedAt: 'desc' },
                skip,
                take: limit,
            }),
            this.prisma.checkLog.count({ where }),
        ]);

        return monitoringProjection(
            {
                data: logs.map((log) => new CheckLogEntity(log)),
                meta: {
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit),
                },
            },
            access.effectiveRole,
        );
    }

    /**
     * One batch (round): the local check row that anchored it plus every probe
     * report that carried the same `roundId`.
     *
     * While the batch is still open the row carries the raw local verdict and
     * `aggregation` is null; a settled batch carries the aggregated verdict and
     * the vote summary the settlement wrote into `CheckLog.meta`.
     */
    async getRoundDetail(
        projectId: string,
        monitorId: string,
        roundId: string,
        principal: AccessPrincipal,
    ): Promise<CheckRoundEntity> {
        const access = await this.access.project(
            principal,
            projectId,
            'monitor.read',
        );
        const monitor = await this.prisma.monitor.findFirst({
            where: { id: monitorId, projectId, deletedAt: null },
            select: { id: true },
        });
        if (!monitor) throw new NotFoundException('Monitor not found');

        const where = {
            monitorId,
            projectId,
            organizationId: access.organizationId,
            roundId,
        };
        const [check, results] = await Promise.all([
            this.prisma.checkLog.findFirst({ where }),
            this.prisma.probeResult.findMany({
                where,
                orderBy: { checkedAt: 'asc' },
                include: {
                    probe: {
                        select: {
                            id: true,
                            name: true,
                            scope: true,
                            provider: true,
                            region: true,
                            status: true,
                            enabled: true,
                            lastHeartbeat: true,
                        },
                    },
                },
            }),
        ]);
        if (!check) throw new NotFoundException('Check round not found');

        const meta = (check.meta ?? {}) as Record<string, unknown>;
        return monitoringProjection(
            new CheckRoundEntity({
                roundId,
                settled: check.appliedAt !== null,
                check: new CheckLogEntity(check),
                aggregation:
                    (meta.aggregation as
                        CheckRoundAggregationEntity | undefined) ?? null,
                results: results.map(
                    (row) =>
                        new CheckRoundProbeResultEntity({
                            id: row.id,
                            probeId: row.probeId,
                            probe: row.probe
                                ? new CheckRoundProbeEntity(row.probe)
                                : null,
                            success: row.success,
                            error: row.error,
                            latency: row.latency,
                            statusCode: row.statusCode,
                            target: row.target,
                            checkedAt: row.checkedAt,
                            receivedAt: row.receivedAt,
                            appliedAt: row.appliedAt,
                        }),
                ),
            }),
            access.effectiveRole,
        );
    }

    /**
     * Settles one batch: reads the pending CheckLog row, samples the bound
     * tenant probes, aggregates, and hands the verdict to `StateService.settle`.
     *
     * Exactly one settlement wins per `(monitorId, roundId)`; later calls return
     * `DUPLICATE`.
     */
    async settleRound(
        monitorId: string,
        roundId: string,
        options: { force?: boolean } = {},
    ): Promise<RoundSettlement> {
        const log = await this.prisma.checkLog.findUnique({
            where: { monitorId_roundId: { monitorId, roundId } },
        });
        if (!log) return { outcome: 'NOT_FOUND', execution: null };
        if (log.appliedAt) return { outcome: 'DUPLICATE', execution: null };

        const monitor = await this.prisma.monitor.findFirst({
            where: { id: monitorId, enabled: true, deletedAt: null },
            include: { state: true },
        });
        if (!monitor) return { outcome: 'NOT_FOUND', execution: null };
        // A definition change while the batch was open discards it.
        if (
            monitor.configRevision !== log.configRevision ||
            monitor.revision !== log.revision
        ) {
            return { outcome: 'DUPLICATE', execution: null };
        }

        const metaRecord = (log.meta ?? {}) as Record<string, unknown>;
        const guards = (metaRecord.aggregation ?? {
            protected: false,
            protectedReason: null,
        }) as AggregationGuards;

        const localVerdict = {
            success: log.localSuccess ?? log.success,
            error: log.error,
            failureKind: (log.failureKind as CheckFailureKind | null) ?? null,
            serviceVerdict: this.serviceVerdictFromLog(log),
            sslVerdict: (log.sslVerdict as CheckResult['sslVerdict']) ?? null,
            latency: log.latency,
            statusCode: log.statusCode,
            checkedAt: log.checkedAt,
            evaluated: log.evaluated !== false,
        };

        let expectedProbeCount = 0;
        let tenantProbeCount = 0;
        let systemProbeCount = 0;
        let samples: ProbeVerdictSample[] = [];
        if (!guards.protected) {
            const verdict = await this.fetchProbeVerdict(
                monitor,
                roundId,
                log.checkedAt,
            );
            expectedProbeCount = verdict.expectedProbeCount;
            samples = verdict.samples;
            tenantProbeCount = verdict.tenantSampleCount;
            systemProbeCount = samples.length - tenantProbeCount;
            const ready =
                expectedProbeCount === 0 ||
                samples.length >= expectedProbeCount;
            if (!ready && !options.force) {
                // Not everyone reported yet: close the batch at its deadline.
                await this.scheduleDeadlineSettlement(
                    monitor,
                    roundId,
                    log.checkedAt,
                );
                return { outcome: 'PENDING', execution: null };
            }
        }

        // The denominator is what actually arrived: a probe that never reported
        // for this batch is dropped instead of counting as a failure.
        const votingProbeCount = samples.length;
        const hasVote = !guards.protected && votingProbeCount > 0;
        const evaluation = hasVote
            ? this.evaluateRound(monitor, localVerdict, {
                  expectedProbeCount,
                  tenantSampleCount: tenantProbeCount,
                  samples,
              })
            : null;

        const passed = evaluation ? evaluation.passed : localVerdict.success;
        const fallbackLocal = evaluation === null;

        const successCount = evaluation?.successCount ?? 0;
        const aggregatedError = evaluation?.error ?? null;

        let finalSuccess: boolean;
        let decision: AppliedAggregation['decision'];
        let failureKind = localVerdict.failureKind;
        let serviceVerdict = localVerdict.serviceVerdict;
        let rescuedByProbe = false;

        if (fallbackLocal) {
            // No voting probe reported: the local verdict stands. System probes
            // are part of the vote now, so there is no separate rescue path.
            finalSuccess = passed;
            failureKind = passed ? null : localVerdict.failureKind;
            decision = 'FALLBACK_LOCAL';
        } else if (passed && localVerdict.success) {
            finalSuccess = true;
            failureKind = null;
            decision = 'CONFIRMED_SUCCESS';
        } else if (passed) {
            // A failing local check is rescued by the probe majority.
            finalSuccess = true;
            failureKind = null;
            serviceVerdict = 'SUCCESS';
            rescuedByProbe = true;
            decision = 'RESCUED';
        } else if (localVerdict.success) {
            // The probes vetoed a successful local check.
            finalSuccess = false;
            failureKind = 'AGGREGATE';
            serviceVerdict = 'FAILURE';
            decision = 'OVERTURNED';
        } else {
            finalSuccess = false;
            decision = 'CONFIRMED_FAILURE';
        }

        const error = finalSuccess
            ? null
            : (aggregatedError ?? localVerdict.error ?? 'Check failed');
        const finalResult: CheckResult = {
            success: finalSuccess,
            latency: localVerdict.latency,
            error,
            checkedAt: localVerdict.checkedAt,
            statusCode: localVerdict.statusCode,
            // The local evidence is replayed so the rule tree sees the same
            // context it saw before the batch closed.
            bodyContains:
                (metaRecord.localBodyContains as string | null) ?? null,
            ssl: this.sslFromMeta(metaRecord),
            sslVerdict: localVerdict.sslVerdict ?? undefined,
            evaluated: localVerdict.evaluated,
            failureKind,
            meta: this.checkMetadataFrom(metaRecord),
        };

        // The rule tree runs against the aggregated verdict; the row keeps the
        // local verdict until the settlement overwrites it.
        const ruleOutcome = await this.evaluateRuleTree(monitor, finalResult);

        const aggregation: AppliedAggregation = {
            protected: guards.protected,
            protectedReason: guards.protectedReason,
            effectiveProbeCount: votingProbeCount,
            expectedProbeCount,
            tenantProbeCount,
            systemProbeCount,
            sampleCount: samples.length,
            successCount,
            ratio:
                votingProbeCount > 0
                    ? Math.round((successCount * 10000) / votingProbeCount) /
                      100
                    : finalSuccess
                      ? 100
                      : 0,
            threshold: monitor.probeSuccessRatio,
            decision,
            settledAt: new Date().toISOString(),
        };

        const settled = await this.stateService.settle(monitorId, roundId, {
            roundId,
            success: finalSuccess,
            error,
            latency: localVerdict.latency,
            statusCode: localVerdict.statusCode,
            localSuccess: localVerdict.success,
            rescuedByProbe,
            failureKind,
            serviceVerdict,
            localServiceVerdict: localVerdict.serviceVerdict,
            ssl: this.sslFromMeta(metaRecord),
            sslVerdict: localVerdict.sslVerdict ?? undefined,
            failureReason: metaRecord.localFailureReason as string | undefined,
            ruleMatched: ruleOutcome.ruleMatched,
            ruleGroupIds: ruleOutcome.ruleGroupIds,
            ruleEvidence: ruleOutcome.ruleEvidence,
            aggregation,
            configRevision: monitor.configRevision,
            revision: monitor.revision,
        });

        if (!settled) {
            // Another worker (or a definition change) already closed this batch.
            return { outcome: 'DUPLICATE', execution: null };
        }

        const execution: CheckExecution = {
            ...finalResult,
            monitorId,
            previousStatus: settled.transition.previousStatus,
            status: settled.transition.status,
            changed: settled.transition.changed,
            notified: {
                skipped: !settled.deliveries,
                sent: settled.deliveries,
                failed: 0,
            },
            applied: true,
        };

        return { outcome: 'SETTLED', execution };
    }

    // -- Internals -------------------------------------------------------

    /**
     * Anchors one batch: settles any older open batch of the monitor, appends the
     * pending CheckLog row that carries the local evidence, and advances only the
     * scheduling anchors of `MonitorState`.
     */
    private async beginRound(input: {
        monitor: MonitorModel;
        roundId: string;
        startedAt: Date;
        localResult: CheckResult;
        guards: AggregationGuards;
        ruleOutcome: RuleOutcome;
    }): Promise<{ state: MonitorStateModel; roundId: string } | null> {
        const {
            monitor,
            roundId,
            startedAt,
            localResult,
            guards,
            ruleOutcome,
        } = input;

        // Close any expired batch first so `failCount` advances in batch order.
        await this.settleStaleRounds(monitor, roundId);

        const evaluated = localResult.evaluated !== false;
        const meta = {
            ...(localResult.meta ?? {}),
            ...(localResult.bodyContains
                ? { localBodyContains: localResult.bodyContains }
                : {}),
            ...(localResult.ssl
                ? {
                      localSsl: {
                          expiresAt: localResult.ssl.expiresAt.toISOString(),
                          daysRemaining: localResult.ssl.daysRemaining,
                          issuer: localResult.ssl.issuer,
                          subject: localResult.ssl.subject,
                      },
                  }
                : {}),
            ...(localResult.failureReason
                ? { localFailureReason: localResult.failureReason }
                : {}),
            ...(ruleOutcome.ruleEvidence
                ? { ruleEvidence: ruleOutcome.ruleEvidence }
                : {}),
            aggregation: {
                protected: guards.protected,
                protectedReason: guards.protectedReason,
            },
        };

        for (let attempt = 0; attempt < ROUND_ANCHOR_ATTEMPTS; attempt += 1) {
            // Two checks of one monitor can start in the same millisecond; the
            // unique index then rejects the second batch. Suffix that one
            // instead of dropping the run.
            const anchoredRoundId =
                attempt === 0 ? roundId : `${roundId}~${randomUUID()}`;

            try {
                const state = await this.prisma.$transaction(async (tx) => {
                    await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${monitor.organizationId} FOR SHARE`;
                    await tx.$queryRaw`SELECT id FROM monitors WHERE id = ${monitor.id} FOR UPDATE`;
                    const current = await tx.monitor.findFirst({
                        where: { id: monitor.id, deletedAt: null },
                        include: { state: true },
                    });
                    if (
                        !current ||
                        !current.enabled ||
                        current.revision !== monitor.revision ||
                        capacityRestricted(current)
                    )
                        return null;
                    await tx.checkLog.create({
                        data: {
                            monitorId: monitor.id,
                            monitorRefId: monitor.id,
                            organizationId: monitor.organizationId,
                            projectId: monitor.projectId,
                            monitorType: monitor.type,
                            configRevision: monitor.configRevision,
                            serviceVerdict: localResult.serviceVerdict ?? null,
                            localServiceVerdict:
                                localResult.serviceVerdict ?? null,
                            sslVerdict: localResult.sslVerdict ?? null,
                            success: localResult.success,
                            localSuccess: localResult.success,
                            rescuedByProbe: false,
                            latency: localResult.latency,
                            error: localResult.error,
                            statusCode: localResult.statusCode ?? null,
                            ruleMatched: ruleOutcome.ruleMatched,
                            ruleGroupIds: ruleOutcome.ruleGroupIds,
                            source: CheckSource.LOCAL,
                            checkedAt: startedAt,
                            revision: monitor.revision,
                            evaluated,
                            failureKind: localResult.failureKind ?? null,
                            meta: meta,
                            roundId: anchoredRoundId,
                            appliedAt: null,
                        },
                    });

                    // Status, failCount, connectivity and availability are written
                    // by the settlement only: a pending row must not advance them.
                    return tx.monitorState.upsert({
                        where: { monitorId: monitor.id },
                        create: {
                            monitorId: monitor.id,
                            lastCheckAt: evaluated ? startedAt : null,
                            lastLocalCheckAt: startedAt,
                            executionBlockedReason: evaluated
                                ? null
                                : localResult.error,
                        },
                        update: {
                            lastCheckAt: evaluated ? startedAt : undefined,
                            lastLocalCheckAt: startedAt,
                            executionBlockedReason: current.state?.noDataSince
                                ? 'NO_DATA'
                                : evaluated
                                  ? null
                                  : localResult.error,
                        },
                    });
                });

                return state ? { state, roundId: anchoredRoundId } : null;
            } catch (caught) {
                // `(monitorId, roundId)` is unique: that batch id is taken.
                if (
                    !(caught instanceof Prisma.PrismaClientKnownRequestError) ||
                    caught.code !== 'P2002'
                ) {
                    throw caught;
                }
                if (attempt === ROUND_ANCHOR_ATTEMPTS - 1) return null;
            }
        }

        return null;
    }

    /** Settles open batches of this monitor whose deadline already passed. */
    private async settleStaleRounds(
        monitor: MonitorModel,
        currentRoundId: string,
    ): Promise<void> {
        const stale = await this.prisma.checkLog.findMany({
            where: {
                monitorId: monitor.id,
                roundId: { not: null },
                appliedAt: null,
            },
            select: { roundId: true, checkedAt: true },
        });
        const deadlineMs = monitor.interval * 1000;

        for (const row of stale) {
            if (!row.roundId || row.roundId === currentRoundId) continue;
            // A manual check can start before the previous batch expires; leave
            // it to the deadline job instead of judging partial evidence.
            if (Date.now() - row.checkedAt.getTime() < deadlineMs) continue;
            try {
                await this.settleRound(monitor.id, row.roundId, {
                    force: true,
                });
            } catch (error) {
                this.logger.warn(
                    `Failed to settle stale round ${row.roundId} of monitor ${monitor.id}: ${(error as Error).message}`,
                );
            }
        }
    }

    /**
     * Votes for one batch: bound, enabled and online tenant probes plus the
     * system probes the scheduler assigned to this monitor.
     *
     * `tenantProbesOnly` on the plan keeps the assigned system probes out of the
     * vote even though they still run and report.
     */
    private async fetchProbeVerdict(
        monitor: MonitorModel,
        roundId: string,
        roundStart: Date,
    ): Promise<ProbeVerdict> {
        const [tenantProbes, systemProbes] = await Promise.all([
            this.prisma.probe.findMany({
                where: {
                    organizationId: monitor.organizationId,
                    scope: 'TENANT',
                    enabled: true,
                    status: 'ONLINE',
                    monitors: { some: { monitorId: monitor.id } },
                },
                select: { id: true },
            }),
            this.assignedSystemProbes(monitor),
        ]);

        const voters = [...tenantProbes, ...systemProbes];
        if (voters.length === 0) {
            return {
                expectedProbeCount: 0,
                tenantSampleCount: 0,
                samples: [],
            };
        }

        const since = new Date(
            roundStart.getTime() - probeResultWindowMs(monitor.interval),
        );
        const previousRoundId = await this.findPreviousRoundId(
            monitor.id,
            roundStart,
        );
        const rows = await this.prisma.probeResult.findMany({
            where: {
                monitorId: monitor.id,
                target: monitor.target,
                configRevision: monitor.configRevision,
                checkedAt: { gte: since },
                probeId: { in: voters.map((probe) => probe.id) },
                OR: [
                    { roundId },
                    ...(previousRoundId ? [{ roundId: previousRoundId }] : []),
                    { roundId: null },
                ],
            },
            select: {
                id: true,
                probeId: true,
                success: true,
                checkedAt: true,
                receivedAt: true,
            },
            orderBy: [
                { checkedAt: 'desc' },
                { receivedAt: 'desc' },
                { id: 'desc' },
            ],
        });

        // The newest row per probe is that probe's vote; `id` is only a
        // deterministic tie-break, not a claim about observation order.
        const latest = new Map<string, ProbeVerdictSample>();
        for (const row of rows) {
            if (!latest.has(row.probeId)) latest.set(row.probeId, row);
        }

        const samples = [...latest.values()];
        const tenantIds = new Set(tenantProbes.map((probe) => probe.id));

        return {
            expectedProbeCount: voters.length,
            tenantSampleCount: samples.filter((sample) =>
                tenantIds.has(sample.probeId),
            ).length,
            samples,
        };
    }

    /**
     * System probes that vote for this monitor. A monitor can opt into
     * tenant-only judging (`tenantProbesOnly`): the assigned system probes still
     * run and report, they just stay out of the vote.
     *
     * Redis holds the assignment table, so an unreachable cache means "no system
     * votes" instead of failing the settlement.
     */
    private async assignedSystemProbes(
        monitor: MonitorModel,
    ): Promise<{ id: string }[]> {
        if (monitor.tenantProbesOnly) return [];

        let assigned: string[];
        try {
            assigned = await this.systemProbeScheduler.getAssignedProbes(
                monitor.id,
            );
        } catch (error) {
            this.logger.warn(
                `System probe assignments unavailable for monitor ${monitor.id}: ${(error as Error).message}`,
            );
            return [];
        }

        if (assigned.length === 0) return [];

        return this.prisma.probe.findMany({
            where: {
                id: { in: assigned },
                scope: 'SYSTEM',
                enabled: true,
                status: 'ONLINE',
            },
            select: { id: true },
        });
    }

    /** Round id of the batch that directly preceded `roundStart`. */
    private async findPreviousRoundId(
        monitorId: string,
        roundStart: Date,
    ): Promise<string | null> {
        const previous = await this.prisma.checkLog.findFirst({
            where: {
                monitorId,
                roundId: { not: null },
                checkedAt: { lt: roundStart },
            },
            orderBy: { checkedAt: 'desc' },
            select: { roundId: true },
        });

        return previous?.roundId ?? null;
    }

    /** Integer cross-multiplication: `successCount * 100 >= ratio * N`. */
    private evaluateRound(
        monitor: MonitorModel,
        localVerdict: { success: boolean; error: string | null },
        verdict: ProbeVerdict,
    ): { passed: boolean; successCount: number; error: string | null } {
        // Only the probes that reported vote: a missing report is not evidence
        // against the target.
        const denominator = verdict.samples.length;
        const successCount = verdict.samples.filter(
            (sample) => sample.success,
        ).length;
        const passed =
            successCount * 100 >= monitor.probeSuccessRatio * denominator;

        return {
            passed,
            successCount,
            error: passed
                ? null
                : this.buildAggregatedError(
                      localVerdict,
                      successCount,
                      denominator,
                      monitor.probeSuccessRatio,
                  ),
        };
    }

    /** Registers the deadline job that closes a batch nobody completed. */
    private async scheduleDeadlineSettlement(
        monitor: MonitorModel,
        roundId: string,
        roundStart: Date,
    ): Promise<void> {
        if (!this.checkQueue) {
            this.logger.warn(
                `No check queue available; round ${roundId} will be settled by the next local check`,
            );
            return;
        }

        const delay = Math.max(
            roundStart.getTime() + monitor.interval * 1000 - Date.now(),
            1000,
        );

        try {
            await this.checkQueue.add(
                MONITOR_SETTLE_JOB,
                { monitorId: monitor.id, roundId },
                {
                    // BullMQ rejects ':' in custom job ids.
                    jobId: `${MONITOR_CHECK_DEDUP_PREFIX}-settle-${roundId.replaceAll(':', '_')}`,
                    delay,
                    removeOnComplete: true,
                    removeOnFail: 100,
                },
            );
        } catch (error) {
            this.logger.warn(
                `Failed to schedule settlement of round ${roundId}: ${(error as Error).message}`,
            );
        }
    }

    private async execute(
        monitor: MonitorModel,
        trigger: ExecutionTrigger = ExecutionTrigger.SCHEDULED,
    ): Promise<CheckExecution> {
        // The batch is anchored at the server clock read before the local check
        // starts, so local evidence and probe reports share one window.
        const startedAt = new Date();
        const localResult = await this.probe(monitor);
        const roundId = buildRoundId(monitor.id, startedAt);
        const guards = this.aggregationGuards(monitor, localResult);
        // Rule tree only produces a verdict (matched = abnormal); it is stored
        // with the local evidence and recomputed once the batch settled.
        const ruleOutcome = await this.evaluateRuleTree(monitor, localResult);

        // A plan can expire while a slow network operation is in flight.
        const eligibility = await this.quotaService.monitorEligibility(
            monitor.organizationId,
            monitor.type,
            monitor.interval,
            undefined,
            monitor.id,
        );
        if (!eligibility.eligible) {
            return {
                ...localResult,
                evaluated: false,
                applied: false,
                failureKind: 'POLICY',
                error: eligibility.reason,
                monitorId: monitor.id,
                previousStatus: 'UNKNOWN',
                status: 'UNKNOWN',
                changed: false,
                notified: { skipped: true, sent: 0, failed: 0 },
            };
        }

        const anchor = await this.beginRound({
            monitor,
            roundId,
            startedAt,
            localResult,
            guards,
            ruleOutcome,
        });
        if (!anchor) {
            return this.pendingExecution(monitor, localResult, null);
        }

        // Protected batches settle right away; the others either reach quorum
        // here or close at the deadline job. The anchored id may carry a suffix
        // when two checks started in the same millisecond.
        const settlement = guards.protected
            ? await this.settleRound(monitor.id, anchor.roundId, {
                  force: true,
              })
            : await this.settleRound(monitor.id, anchor.roundId);
        const execution =
            settlement.execution ??
            this.pendingExecution(monitor, localResult, anchor.state);

        await this.writeExecution(monitor, execution, trigger, {
            previousStatus: execution.previousStatus,
            status: execution.status,
            changed: execution.changed,
            ruleGroupIds: ruleOutcome.ruleGroupIds,
            notified: {
                skipped: execution.notified.skipped,
                sent: execution.notified.sent,
                failed: execution.notified.failed,
            },
        });

        return execution;
    }

    /**
     * Response for a batch that exists but is not settled yet: the local verdict
     * is returned, the state stays untouched.
     */
    private pendingExecution(
        monitor: MonitorModel,
        result: CheckResult,
        state: MonitorStateModel | null,
    ): CheckExecution {
        const status = state?.status ?? 'UNKNOWN';

        return {
            ...result,
            monitorId: monitor.id,
            previousStatus: status,
            status,
            changed: false,
            notified: { skipped: true, sent: 0, failed: 0 },
            applied: false,
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
                    status:
                        result.evaluated === false
                            ? ExecutionStatus.SKIPPED
                            : result.success
                              ? ExecutionStatus.SUCCESS
                              : ExecutionStatus.FAILED,
                    success: result.success,
                    latency: result.latency,
                    error: result.error,
                    requestMeta: {
                        source: CheckSource.LOCAL,
                        monitorType: monitor.type,
                        revision: monitor.revision,
                        configVersion: monitor.configVersion,
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
        return this.registry.check(monitor);
    }

    private acceptsLegacyProbe(monitor: MonitorModel): boolean {
        return (
            [MonitorType.HTTP, MonitorType.TCP].includes(
                monitor.type as 'HTTP' | 'TCP',
            ) &&
            (!monitor.checkSsl || monitor.configRevision !== undefined) &&
            !!monitor.config &&
            typeof monitor.config === 'object' &&
            !Array.isArray(monitor.config) &&
            Object.keys(monitor.config).length === 0 &&
            (monitor.revision === 1 || monitor.configRevision !== undefined)
        );
    }

    /**
     * Decides whether the batch may be judged by probes at all. The order
     * mirrors the protection blocks of the previous `evaluateResult`.
     */
    private aggregationGuards(
        monitor: MonitorModel,
        localResult: CheckResult,
    ): AggregationGuards {
        if (!this.acceptsLegacyProbe(monitor)) {
            return { protected: true, protectedReason: 'LEGACY_UNSUPPORTED' };
        }
        if (localResult.evaluated === false) {
            return { protected: true, protectedReason: 'UNEVALUATED' };
        }
        if (localResult.failureKind === 'ASSERTION') {
            return { protected: true, protectedReason: 'ASSERTION' };
        }

        // A certificate verdict is a fact about the certificate, not a
        // reachability signal, so probes must not override it.
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
            return { protected: true, protectedReason: 'SSL' };
        }

        return { protected: false, protectedReason: null };
    }

    /** Local service verdict recovered from the pending CheckLog row. */
    private serviceVerdictFromLog(log: {
        localServiceVerdict: string | null;
        sslVerdict: string | null;
        localSuccess: boolean | null;
        success: boolean;
    }): NonNullable<CheckResult['serviceVerdict']> {
        return (
            (log.localServiceVerdict as CheckResult['serviceVerdict']) ??
            (log.sslVerdict === 'INVALID'
                ? 'NO_EVIDENCE'
                : log.sslVerdict &&
                    ['EXPIRING', 'EXPIRED'].includes(log.sslVerdict)
                  ? 'SUCCESS'
                  : (log.localSuccess ?? log.success)
                    ? 'SUCCESS'
                    : 'FAILURE')
        );
    }

    /** Rebuilds the local certificate evidence stored with the batch row. */
    private sslFromMeta(
        meta: Record<string, unknown>,
    ): CheckResult['ssl'] | undefined {
        const raw = meta.localSsl as
            | {
                  expiresAt?: string;
                  daysRemaining?: number;
                  issuer?: string | null;
                  subject?: string | null;
              }
            | undefined;
        if (!raw?.expiresAt) return undefined;

        return {
            expiresAt: new Date(raw.expiresAt),
            daysRemaining: raw.daysRemaining ?? 0,
            issuer: raw.issuer ?? null,
            subject: raw.subject ?? null,
        };
    }

    /** Protocol metadata of the local check, without the aggregation keys. */
    private checkMetadataFrom(
        meta: Record<string, unknown>,
    ): CheckMetadata | undefined {
        if (typeof meta.protocol !== 'string') return undefined;

        const rest = { ...meta };
        delete rest.aggregation;
        delete rest.localSsl;
        delete rest.localFailureReason;
        delete rest.localBodyContains;
        delete rest.ruleEvidence;

        return rest as unknown as CheckMetadata;
    }

    private buildAggregatedError(
        localVerdict: { success: boolean; error: string | null },
        successCount: number,
        probeCount: number,
        threshold: number,
    ): string {
        const ratio = `probe success ratio ${successCount}/${probeCount} below ${threshold}%`;

        return localVerdict.success
            ? `Probe success ratio ${successCount}/${probeCount} below ${threshold}% (local check succeeded)`
            : `${localVerdict.error ?? 'Local check failed'}; ${ratio}`;
    }

    private isDue(intervalSeconds: number, lastCheckAt: Date | null): boolean {
        if (!lastCheckAt) return true;

        return Date.now() - lastCheckAt.getTime() >= intervalSeconds * 1000;
    }

    /** 构造规则求值上下文，来自聚合后的CheckResult。*/
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
