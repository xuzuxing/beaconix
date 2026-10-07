import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleInit,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../infra/database/prisma.service';
import { ScheduledJobRegistry } from '../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../infra/scheduler/scheduled-jobs.constants';
import { PROBE_OFFLINE_INTERVAL_FACTOR } from '../../config';
import type { ProbeConfig } from '../../config';
import {
    ExecutionStatus,
    ExecutionTrigger,
    ProbeScope,
    ProbeStatus,
} from '../../generated/prisma/enums';
import type { InputJsonValue } from '../../generated/prisma/internal/prismaNamespace';
import type { ProbeModel } from '../../generated/prisma/models';
import { SystemProbeScheduler } from '../admin/system-probes/system-probe-scheduler';
import { QuotaService } from '../../shared/quota/quota.service';
import { CheckerService } from '../checker/checker.service';
import {
    BindMonitorsDto,
    CreateProbeDto,
    QueryProbeExecutionsDto,
    ProbeResultItemDto,
    QueryProbeResultsDto,
    UpdateProbeDto,
} from './dto';
import {
    ProbeEntity,
    ProbeExecutionEntity,
    ProbeMonitorEntity,
    ProbeResultEntity,
} from './entities';

/** How many reported targets are folded into monitor state in parallel. */
const PROBE_REPORT_CONCURRENCY = 5;

/** One reported target that was applied to a monitor. */
export interface AppliedOutcome {
    target: string;
    monitorId: string;
    status: string;
    changed: boolean;
}

const MONITOR_SELECT = {
    id: true,
    name: true,
    type: true,
    target: true,
    interval: true,
    timeout: true,
    expectedStatus: true,
    failureThreshold: true,
    enabled: true,
    deletedAt: true,
} as const;

export interface ProbeHeartbeatResult {
    probe: {
        id: string;
        name: string;
        status: string;
        lastHeartbeat: Date | null;
    };
    monitors: Array<{
        id: string;
        name: string;
        type: string;
        target: string;
        interval: number;
        timeout: number;
        expectedStatus: number;
    }>;
    serverTime: string;
}

@Injectable()
export class ProbesService implements OnModuleInit {
    private readonly logger = new Logger(ProbesService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly checkerService: CheckerService,
        private readonly systemProbeScheduler: SystemProbeScheduler,
        private readonly quotaService: QuotaService,
        private readonly configService: ConfigService,
        private readonly registry: ScheduledJobRegistry,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.probeOfflineSweep,
            pattern: SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.probeOfflineSweep],
            handler: () => this.markStaleProbesOffline(),
        });
    }

    async create(orgId: string, dto: CreateProbeDto): Promise<ProbeEntity> {
        await this.quotaService.assertFeatureAllowed(orgId, 'tenantProbe');
        await this.quotaService.assertCanCreate(orgId, 'probes');

        const probe = await this.prisma.probe.create({
            data: {
                organizationId: orgId,
                scope: ProbeScope.TENANT,
                name: dto.name,
                provider: dto.provider,
                region: dto.region,
                callbackUrl: dto.callbackUrl,
                enabled: dto.enabled ?? true,
                secret: this.generateSecret('tnt'),
            },
        });

        return this.toEntity(probe);
    }

    async findAll(orgId: string): Promise<ProbeEntity[]> {
        const probes = await this.prisma.probe.findMany({
            where: { organizationId: orgId, scope: ProbeScope.TENANT },
            include: {
                monitors: { include: { monitor: { select: MONITOR_SELECT } } },
                _count: { select: { results: true } },
            },
            orderBy: { createdAt: 'desc' },
        });

        return probes.map((probe) => this.toEntity(probe));
    }

    async findOne(orgId: string, probeId: string): Promise<ProbeEntity> {
        const probe = await this.ensureProbeExists(orgId, probeId);
        return this.toEntity(probe);
    }

    async update(
        orgId: string,
        probeId: string,
        dto: UpdateProbeDto,
    ): Promise<ProbeEntity> {
        await this.ensureProbeExists(orgId, probeId);

        const probe = await this.prisma.probe.update({
            where: { id: probeId },
            data: {
                name: dto.name,
                provider: dto.provider,
                region: dto.region,
                callbackUrl: dto.callbackUrl,
                enabled: dto.enabled,
            },
            include: {
                monitors: { include: { monitor: { select: MONITOR_SELECT } } },
                _count: { select: { results: true } },
            },
        });

        if (dto.enabled !== undefined) {
            await this.systemProbeScheduler.rebalance();
        }

        return this.toEntity(probe);
    }

    /** Probes have no soft-delete column: removing one drops its results too. */
    async remove(orgId: string, probeId: string): Promise<void> {
        await this.ensureProbeExists(orgId, probeId);

        await this.prisma.probe.delete({ where: { id: probeId } });
        await this.systemProbeScheduler.rebalance();
    }

    async rotateSecret(orgId: string, probeId: string): Promise<ProbeEntity> {
        await this.ensureProbeExists(orgId, probeId);

        const probe = await this.prisma.probe.update({
            where: { id: probeId },
            data: {
                secret: this.generateSecret('tnt'),
                // The probe must call in again with the new secret.
                status: ProbeStatus.OFFLINE,
            },
            include: {
                monitors: { include: { monitor: { select: MONITOR_SELECT } } },
                _count: { select: { results: true } },
            },
        });

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(probe);
    }

    async bindMonitors(
        orgId: string,
        probeId: string,
        dto: BindMonitorsDto,
    ): Promise<ProbeEntity> {
        await this.ensureProbeExists(orgId, probeId);

        const monitors = await this.prisma.monitor.findMany({
            where: {
                id: { in: dto.monitorIds },
                organizationId: orgId,
                deletedAt: null,
            },
            select: { id: true },
        });

        if (monitors.length !== new Set(dto.monitorIds).size) {
            throw new BadRequestException(
                'One or more monitors were not found in this organization',
            );
        }

        await this.prisma.monitorProbe.createMany({
            data: monitors.map((monitor) => ({
                monitorId: monitor.id,
                probeId,
            })),
            skipDuplicates: true,
        });

        await this.systemProbeScheduler.rebalance();

        return this.findOne(orgId, probeId);
    }

    async unbindMonitor(
        orgId: string,
        probeId: string,
        monitorId: string,
    ): Promise<ProbeEntity> {
        await this.ensureProbeExists(orgId, probeId);

        const binding = await this.prisma.monitorProbe.findUnique({
            where: { monitorId_probeId: { monitorId, probeId } },
        });

        if (!binding) {
            throw new NotFoundException(
                'Monitor is not attached to this probe',
            );
        }

        await this.prisma.monitorProbe.delete({
            where: { monitorId_probeId: { monitorId, probeId } },
        });

        await this.systemProbeScheduler.rebalance();

        return this.findOne(orgId, probeId);
    }

    /** Paginated raw results reported by one probe. */
    async listResults(
        orgId: string,
        probeId: string,
        query: QueryProbeResultsDto,
    ) {
        await this.ensureProbeExists(orgId, probeId);

        const page = query.page ?? 1;
        const limit = query.limit ?? 20;
        const skip = (page - 1) * limit;

        const where: Record<string, unknown> = { probeId };
        if (query.target) where.target = query.target;

        const [results, total] = await Promise.all([
            this.prisma.probeResult.findMany({
                where,
                orderBy: { checkedAt: 'desc' },
                skip,
                take: limit,
            }),
            this.prisma.probeResult.count({ where }),
        ]);

        return {
            data: results.map((result) => new ProbeResultEntity(result)),
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    /** Paginated execution audit records for one tenant probe. */
    async listExecutions(
        orgId: string,
        probeId: string,
        query: QueryProbeExecutionsDto,
    ) {
        await this.ensureProbeExists(orgId, probeId);

        const page = query.page ?? 1;
        const limit = query.limit ?? 20;
        const skip = (page - 1) * limit;

        const where: Record<string, unknown> = { probeId };
        if (query.trigger) where.trigger = query.trigger;
        if (query.status) where.status = query.status;
        if (query.monitorId) where.monitorId = query.monitorId;
        if (query.target) where.target = query.target;

        const [executions, total] = await Promise.all([
            this.prisma.probeExecution.findMany({
                where,
                orderBy: { executedAt: 'desc' },
                skip,
                take: limit,
            }),
            this.prisma.probeExecution.count({ where }),
        ]);

        return {
            data: executions.map(
                (execution) => new ProbeExecutionEntity(execution),
            ),
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    // -- Probe agent API -------------------------------------------------

    /** Marks the probe online and hands back the monitors it should check. */
    async recordHeartbeat(
        secret: string,
        heartbeatIntervalSeconds?: number,
    ): Promise<ProbeHeartbeatResult> {
        const probe = await this.requireProbeBySecret(secret);
        const cameOnline = probe.status !== ProbeStatus.ONLINE;

        const updated = await this.prisma.probe.update({
            where: { id: probe.id },
            data: {
                lastHeartbeat: new Date(),
                status: ProbeStatus.ONLINE,
                // Remembered so the offline sweep can wait three beats instead
                // of a fixed threshold that slow probes can never meet.
                ...(heartbeatIntervalSeconds !== undefined
                    ? { heartbeatIntervalSeconds }
                    : {}),
            },
            include: {
                monitors: { include: { monitor: { select: MONITOR_SELECT } } },
            },
        });

        // A system probe that just came back online must be folded into the
        // assignment table before it is read below - otherwise it keeps getting
        // an empty monitor list until the hourly refresh. Steady-state heartbeats
        // deliberately do not rebalance (that used to rescan every monitor).
        if (cameOnline && updated.scope === ProbeScope.SYSTEM) {
            await this.systemProbeScheduler.rebalance();
        }

        const monitors =
            updated.scope === ProbeScope.SYSTEM
                ? await this.getAssignedSystemProbeMonitors(updated.id)
                : updated.monitors
                      .map((binding) => binding.monitor)
                      .filter(
                          (monitor) =>
                              monitor.deletedAt === null && monitor.enabled,
                      );

        await this.writeExecution({
            probeId: probe.id,
            target: 'heartbeat',
            trigger: ExecutionTrigger.CALLBACK,
            status: ExecutionStatus.SUCCESS,
            success: true,
            requestMeta: {},
            responseMeta: {
                monitorCount: monitors.length,
            },
        });

        return {
            probe: {
                id: updated.id,
                name: updated.name,
                status: updated.status,
                lastHeartbeat: updated.lastHeartbeat,
            },
            monitors: monitors.map((monitor) => ({
                id: monitor.id,
                name: monitor.name,
                type: monitor.type,
                target: monitor.target,
                interval: monitor.interval,
                timeout: monitor.timeout,
                expectedStatus: monitor.expectedStatus,
            })),
            serverTime: new Date().toISOString(),
        };
    }

    /**
     * Stores raw probe results and folds each one into the state of the monitor
     * that owns the reported target.
     *
     * The batch is folded in parallel slices - each target belongs to a
     * different monitor, so handling them strictly one by one only made the
     * probe wait. Reports for the same target inside one batch are collapsed
     * first because they would race on the same monitor state row.
     */
    async recordResults(secret: string, results: ProbeResultItemDto[]) {
        const probe = await this.requireProbeBySecret(secret);
        const receivedAt = new Date();

        await this.prisma.probeResult.createMany({
            data: results.map((result) => ({
                probeId: probe.id,
                target: result.target,
                success: result.success,
                latency: result.latency,
                error: result.error ?? null,
                statusCode: result.statusCode ?? null,
                checkedAt: result.checkedAt
                    ? new Date(result.checkedAt)
                    : new Date(),
            })),
        });

        // Reports may arrive before the first heartbeat; the assignment table has
        // to know about this probe before the results are matched to monitors.
        if (
            probe.status !== ProbeStatus.ONLINE &&
            probe.scope === ProbeScope.SYSTEM
        ) {
            await this.systemProbeScheduler.rebalance();
        }

        const targets = [
            ...new Map(
                results.map((result) => [result.target, result] as const),
            ).values(),
        ];
        const outcomes = new Array<AppliedOutcome | null>(targets.length);
        let cursor = 0;

        const workers = Array.from(
            { length: Math.min(PROBE_REPORT_CONCURRENCY, targets.length) },
            async () => {
                while (cursor < targets.length) {
                    const index = cursor;
                    cursor += 1;

                    outcomes[index] = await this.applyReportedResult(
                        probe,
                        targets[index],
                        receivedAt,
                    );
                }
            },
        );

        await Promise.all(workers);

        await this.prisma.probe.update({
            where: { id: probe.id },
            data: { lastHeartbeat: new Date(), status: ProbeStatus.ONLINE },
        });

        const applied = outcomes.filter(
            (outcome): outcome is AppliedOutcome => outcome !== null,
        );

        return {
            accepted: results.length,
            applied: applied.length,
            outcomes: applied,
        };
    }

    /**
     * Folds a single reported target into monitor state and records the
     * execution. Returns null when the report was stored but not applied.
     */
    private async applyReportedResult(
        probe: ProbeModel,
        result: ProbeResultItemDto,
        receivedAt: Date,
    ): Promise<AppliedOutcome | null> {
        const reportedAt = result.checkedAt
            ? new Date(result.checkedAt)
            : receivedAt;

        const report = {
            target: result.target,
            success: result.success,
            latency: result.latency,
            error: result.error ?? null,
            checkedAt: reportedAt,
            statusCode: result.statusCode ?? null,
        };

        const execution =
            probe.scope === ProbeScope.SYSTEM
                ? await this.applySystemProbeResult(probe.id, report)
                : probe.organizationId
                  ? await this.checkerService.ingestProbeReport(
                        probe.organizationId,
                        report,
                    )
                  : null;

        await this.writeExecution({
            probeId: probe.id,
            monitorId: execution?.monitorId ?? null,
            target: result.target,
            trigger: ExecutionTrigger.CALLBACK,
            status: result.success
                ? ExecutionStatus.SUCCESS
                : ExecutionStatus.FAILED,
            success: result.success,
            latency: result.latency,
            error: result.error ?? null,
            requestMeta: { checkedAt: reportedAt.toISOString() },
            responseMeta: execution
                ? {
                      applied: true,
                      status: execution.status,
                      changed: execution.changed,
                  }
                : { applied: false },
        });

        if (!execution) return null;

        return {
            target: result.target,
            monitorId: execution.monitorId,
            status: execution.status,
            changed: execution.changed,
        };
    }

    /**
     * Flips probes that stopped calling in to OFFLINE.
     *
     * The threshold follows the heartbeat interval each probe reported (three
     * missed beats), falling back to the configured
     * `PROBE_OFFLINE_AFTER_SECONDS` for probes that never reported one - a fixed
     * two minutes used to flip slow probes offline between two beats, which also
     * removed them from the system probe assignment table.
     */
    async markStaleProbesOffline(): Promise<number> {
        const now = Date.now();

        const candidates = await this.prisma.probe.findMany({
            where: { status: ProbeStatus.ONLINE },
            select: {
                id: true,
                lastHeartbeat: true,
                heartbeatIntervalSeconds: true,
            },
        });

        const staleIds = candidates
            .filter((probe) => {
                const last = probe.lastHeartbeat?.getTime() ?? 0;

                return (
                    now - last >=
                    this.offlineAfterMs(probe.heartbeatIntervalSeconds)
                );
            })
            .map((probe) => probe.id);

        if (staleIds.length === 0) return 0;

        const { count } = await this.prisma.probe.updateMany({
            where: { id: { in: staleIds }, status: ProbeStatus.ONLINE },
            data: { status: ProbeStatus.OFFLINE },
        });

        if (count > 0) {
            this.logger.warn(`Marked ${count} probe(s) offline`);
            await this.systemProbeScheduler.rebalance();
        }

        return count;
    }

    /** How long one probe may stay silent before it counts as offline. */
    private offlineAfterMs(reportedIntervalSeconds: number | null): number {
        const configured =
            this.configService.get<ProbeConfig>('probe')!.offlineAfterSeconds *
            1000;

        if (!reportedIntervalSeconds || reportedIntervalSeconds <= 0) {
            return configured;
        }

        return Math.max(
            configured,
            reportedIntervalSeconds * 1000 * PROBE_OFFLINE_INTERVAL_FACTOR,
        );
    }

    // -- Helpers ---------------------------------------------------------

    private generateSecret(prefix: 'sys' | 'tnt'): string {
        return `${prefix}_${randomBytes(32).toString('hex')}`;
    }

    private async getAssignedSystemProbeMonitors(probeId: string) {
        const monitorIds =
            await this.systemProbeScheduler.getAssignedMonitorIds(probeId);

        if (monitorIds.length === 0) return [];

        return this.prisma.monitor.findMany({
            where: {
                id: { in: monitorIds },
                enabled: true,
                deletedAt: null,
            },
            select: MONITOR_SELECT,
        });
    }

    private async applySystemProbeResult(
        probeId: string,
        report: {
            target: string;
            success: boolean;
            latency: number;
            error: string | null;
            checkedAt: Date;
        },
    ) {
        const assignedMonitorIds =
            await this.systemProbeScheduler.getAssignedMonitorIds(probeId);

        if (assignedMonitorIds.length === 0) return null;

        const monitor = await this.prisma.monitor.findFirst({
            where: {
                id: { in: assignedMonitorIds },
                target: report.target,
                enabled: true,
                deletedAt: null,
            },
            select: { id: true },
        });

        if (!monitor) return null;

        return this.checkerService.ingestProbeReportForMonitor(
            monitor.id,
            report,
        );
    }

    /**
     * Resolves a probe from its shared secret. The secret column is unique, so
     * the lookup itself rejects unknown secrets; missing headers are rejected
     * before touching the database.
     */
    private async requireProbeBySecret(secret: string | undefined) {
        if (!secret || secret.trim() === '') {
            throw new UnauthorizedException('Missing probe secret');
        }

        const probe = await this.prisma.probe.findUnique({
            where: { secret: secret.trim() },
        });

        if (!probe) {
            throw new UnauthorizedException('Unknown probe secret');
        }

        if (!probe.enabled) {
            throw new UnauthorizedException('Probe is disabled');
        }

        return probe;
    }

    private async ensureProbeExists(orgId: string, probeId: string) {
        const probe = await this.prisma.probe.findFirst({
            where: {
                id: probeId,
                organizationId: orgId,
                scope: ProbeScope.TENANT,
            },
            include: {
                monitors: { include: { monitor: { select: MONITOR_SELECT } } },
                _count: { select: { results: true } },
            },
        });

        if (!probe) {
            throw new NotFoundException('Probe not found');
        }

        return probe;
    }

    private async writeExecution(data: {
        probeId?: string | null;
        monitorId?: string | null;
        target: string;
        trigger: ExecutionTrigger;
        status: ExecutionStatus;
        success: boolean;
        latency?: number | null;
        error?: string | null;
        requestMeta?: InputJsonValue;
        responseMeta?: InputJsonValue;
    }): Promise<void> {
        await this.prisma.probeExecution.create({
            data: {
                probeId: data.probeId ?? null,
                monitorId: data.monitorId ?? null,
                target: data.target,
                trigger: data.trigger,
                status: data.status,
                success: data.success,
                latency: data.latency ?? null,
                error: data.error ?? null,
                requestMeta: data.requestMeta ?? {},
                responseMeta: data.responseMeta ?? {},
            },
        });
    }

    private toEntity(probe: {
        id: string;
        organizationId: string | null;
        scope: string;
        name: string;
        provider: string;
        region: string;
        callbackUrl: string;
        secret: string;
        enabled: boolean;
        lastHeartbeat: Date | null;
        heartbeatIntervalSeconds: number | null;
        status: string;
        maxTenants: number | null;
        priority: number;
        createdAt: Date;
        updatedAt: Date;
        monitors?: Array<{
            monitor: {
                id: string;
                name: string;
                type: string;
                target: string;
                enabled: boolean;
                deletedAt: Date | null;
            };
        }>;
        _count?: { results: number };
    }): ProbeEntity {
        const monitors = (probe.monitors ?? [])
            .map((binding) => binding.monitor)
            .filter((monitor) => monitor.deletedAt === null)
            .map(
                (monitor) =>
                    new ProbeMonitorEntity({
                        id: monitor.id,
                        name: monitor.name,
                        type: monitor.type,
                        target: monitor.target,
                        enabled: monitor.enabled,
                    }),
            );

        return new ProbeEntity({
            id: probe.id,
            organizationId: probe.organizationId,
            scope: probe.scope,
            name: probe.name,
            provider: probe.provider,
            region: probe.region,
            callbackUrl: probe.callbackUrl,
            secret: probe.secret,
            enabled: probe.enabled,
            lastHeartbeat: probe.lastHeartbeat,
            heartbeatIntervalSeconds: probe.heartbeatIntervalSeconds,
            status: probe.status,
            maxTenants: probe.maxTenants,
            priority: probe.priority,
            createdAt: probe.createdAt,
            updatedAt: probe.updatedAt,
            monitors,
            resultCount: probe._count?.results,
        });
    }
}
