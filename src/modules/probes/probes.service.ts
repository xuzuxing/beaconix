import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../infra/database/prisma.service';
import {
    ExecutionStatus,
    ExecutionTrigger,
    ProbeScope,
    ProbeStatus,
} from '../../generated/prisma/enums';
import type { InputJsonValue } from '../../generated/prisma/internal/prismaNamespace';
import { SystemProbeScheduler } from '../admin/system-probes/system-probe-scheduler';
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

/** A probe that has not called in for this long is considered offline. */
const PROBE_OFFLINE_AFTER_MS = 2 * 60 * 1000;

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
export class ProbesService {
    private readonly logger = new Logger(ProbesService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly checkerService: CheckerService,
        private readonly systemProbeScheduler: SystemProbeScheduler,
    ) {}

    async create(orgId: string, dto: CreateProbeDto): Promise<ProbeEntity> {
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
    async recordHeartbeat(secret: string): Promise<ProbeHeartbeatResult> {
        const probe = await this.requireProbeBySecret(secret);

        const updated = await this.prisma.probe.update({
            where: { id: probe.id },
            data: { lastHeartbeat: new Date(), status: ProbeStatus.ONLINE },
            include: {
                monitors: { include: { monitor: { select: MONITOR_SELECT } } },
            },
        });

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
     */
    async recordResults(secret: string, results: ProbeResultItemDto[]) {
        const probe = await this.requireProbeBySecret(secret);
        const checkedAt = new Date();

        await this.prisma.probeResult.createMany({
            data: results.map((result) => ({
                probeId: probe.id,
                target: result.target,
                success: result.success,
                latency: result.latency,
                error: result.error ?? null,
                checkedAt: result.checkedAt
                    ? new Date(result.checkedAt)
                    : new Date(),
            })),
        });

        const applied: Array<{
            target: string;
            monitorId: string;
            status: string;
            changed: boolean;
        }> = [];

        for (const result of results) {
            const reportedAt = result.checkedAt
                ? new Date(result.checkedAt)
                : checkedAt;
            const execution =
                probe.scope === ProbeScope.SYSTEM
                    ? await this.applySystemProbeResult(probe.id, {
                          target: result.target,
                          success: result.success,
                          latency: result.latency,
                          error: result.error ?? null,
                          checkedAt: reportedAt,
                      })
                    : probe.organizationId
                      ? await this.checkerService.ingestProbeReport(
                            probe.organizationId,
                            {
                                target: result.target,
                                success: result.success,
                                latency: result.latency,
                                error: result.error ?? null,
                                checkedAt: reportedAt,
                            },
                        )
                      : null;

            if (execution) {
                applied.push({
                    target: result.target,
                    monitorId: execution.monitorId,
                    status: execution.status,
                    changed: execution.changed,
                });
            }

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
        }

        await this.prisma.probe.update({
            where: { id: probe.id },
            data: { lastHeartbeat: new Date(), status: ProbeStatus.ONLINE },
        });

        return {
            accepted: results.length,
            applied: applied.length,
            outcomes: applied,
        };
    }

    /** Flips probes that stopped calling in to OFFLINE. */
    @Cron(CronExpression.EVERY_MINUTE, { name: 'probe-offline-sweep' })
    async markStaleProbesOffline(): Promise<number> {
        const threshold = new Date(Date.now() - PROBE_OFFLINE_AFTER_MS);

        const { count } = await this.prisma.probe.updateMany({
            where: {
                status: ProbeStatus.ONLINE,
                OR: [
                    { lastHeartbeat: null },
                    { lastHeartbeat: { lt: threshold } },
                ],
            },
            data: { status: ProbeStatus.OFFLINE },
        });

        if (count > 0) {
            this.logger.warn(`Marked ${count} probe(s) offline`);
            await this.systemProbeScheduler.rebalance();
        }

        return count;
    }

    // -- Helpers ---------------------------------------------------------

    private generateSecret(prefix: 'sys' | 'tnt'): string {
        return `${prefix}_${randomBytes(32).toString('hex')}`;
    }

    private async getAssignedSystemProbeMonitors(probeId: string) {
        await this.systemProbeScheduler.rebalance();
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
