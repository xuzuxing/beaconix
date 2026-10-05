import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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
} from '../../generated/prisma/models';
import type { InputJsonValue } from '../../generated/prisma/internal/prismaNamespace';
import { StateService } from '../state/state.service';
import type { MonitorTransition } from '../state/state.service';
import { NotifierService } from '../notifier/notifier.service';
import type { NotificationResult } from '../notifier/notifier.service';
import { SystemProbeScheduler } from '../admin/system-probes/system-probe-scheduler';
import { HttpChecker, TcpChecker } from './checkers';
import type { CheckResult, ProbeReport } from './checkers';
import { QueryCheckLogsDto } from './dto';
import { CheckLogEntity } from './entities';

/** How many monitors are checked in parallel by one scheduling tick. */
const CHECK_CONCURRENCY = 5;
const PROBE_RESULT_WINDOW_MS = 2 * 60 * 1000;

export interface CheckExecution extends CheckResult {
    monitorId: string;
    previousStatus: string;
    status: string;
    changed: boolean;
    notified: NotificationResult;
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

        return this.execute(
            monitor,
            CheckSource.LOCAL,
            {
                success: localLog.success,
                latency: localLog.latency,
                error: localLog.error,
                checkedAt: report.checkedAt ?? new Date(),
            },
            ExecutionTrigger.CALLBACK,
        );
    }

    /**
     * Checks every enabled, due monitor. Returns how many were due and how many
     * were actually executed (a check may fail without throwing).
     */
    async runDueChecks(): Promise<{ due: number; checked: number }> {
        const monitors = await this.prisma.monitor.findMany({
            where: { enabled: true, deletedAt: null },
            include: { state: { select: { lastCheckAt: true } } },
        });

        const due = monitors.filter((monitor) =>
            this.isDue(monitor.interval, monitor.state?.lastCheckAt ?? null),
        );

        const queue = [...due];
        let checked = 0;

        const workers = Array.from(
            { length: Math.min(CHECK_CONCURRENCY, queue.length) },
            async () => {
                for (
                    let monitor = queue.shift();
                    monitor;
                    monitor = queue.shift()
                ) {
                    try {
                        await this.execute(
                            monitor,
                            CheckSource.LOCAL,
                            undefined,
                            ExecutionTrigger.SCHEDULED,
                        );
                        checked += 1;
                    } catch (error) {
                        this.logger.warn(
                            `Check failed for monitor ${monitor.id}: ${(error as Error).message}`,
                        );
                    }
                }
            },
        );

        await Promise.all(workers);

        return { due: due.length, checked };
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
        const result = await this.evaluateResult(
            monitor,
            reported ?? (await this.probe(monitor)),
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
            },
        );

        const notified = await this.notifyIfChanged(monitor, state, transition);

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
    ): Promise<CheckResult> {
        if (localResult.success) {
            return localResult;
        }

        if (localResult.ssl !== undefined) {
            return localResult;
        }

        const since = new Date(Date.now() - PROBE_RESULT_WINDOW_MS);
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
            return localResult;
        }

        if (probeResults.some((result) => result.success)) {
            return {
                success: true,
                latency: localResult.latency,
                error: null,
                checkedAt: localResult.checkedAt,
            };
        }

        return {
            ...localResult,
            error: this.buildAggregatedError(localResult, probeResults.length),
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
}
