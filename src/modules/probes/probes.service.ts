import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { ProbeStatus } from '../../generated/prisma/enums';
import { CheckerService } from '../checker/checker.service';
import {
    BindMonitorsDto,
    CreateProbeDto,
    ProbeResultItemDto,
    QueryProbeResultsDto,
    UpdateProbeDto,
} from './dto';
import { ProbeEntity, ProbeMonitorEntity, ProbeResultEntity } from './entities';

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
    ) {}

    async create(orgId: string, dto: CreateProbeDto): Promise<ProbeEntity> {
        const probe = await this.prisma.probe.create({
            data: {
                organizationId: orgId,
                name: dto.name,
                provider: dto.provider,
                region: dto.region,
                callbackUrl: dto.callbackUrl,
                enabled: dto.enabled ?? true,
                secret: this.generateSecret(),
            },
        });

        return this.toEntity(probe);
    }

    async findAll(orgId: string): Promise<ProbeEntity[]> {
        const probes = await this.prisma.probe.findMany({
            where: { organizationId: orgId },
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
            data: dto,
            include: {
                monitors: { include: { monitor: { select: MONITOR_SELECT } } },
                _count: { select: { results: true } },
            },
        });

        return this.toEntity(probe);
    }

    /** Probes have no soft-delete column: removing one drops its results too. */
    async remove(orgId: string, probeId: string): Promise<void> {
        await this.ensureProbeExists(orgId, probeId);

        await this.prisma.probe.delete({ where: { id: probeId } });
    }

    async rotateSecret(orgId: string, probeId: string): Promise<ProbeEntity> {
        await this.ensureProbeExists(orgId, probeId);

        const probe = await this.prisma.probe.update({
            where: { id: probeId },
            data: {
                secret: this.generateSecret(),
                // The probe must call in again with the new secret.
                status: ProbeStatus.OFFLINE,
            },
            include: {
                monitors: { include: { monitor: { select: MONITOR_SELECT } } },
                _count: { select: { results: true } },
            },
        });

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

        return {
            probe: {
                id: updated.id,
                name: updated.name,
                status: updated.status,
                lastHeartbeat: updated.lastHeartbeat,
            },
            monitors: updated.monitors
                .map((binding) => binding.monitor)
                .filter(
                    (monitor) => monitor.deletedAt === null && monitor.enabled,
                )
                .map((monitor) => ({
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
            const execution = await this.checkerService.ingestProbeReport(
                probe.organizationId,
                {
                    target: result.target,
                    success: result.success,
                    latency: result.latency,
                    error: result.error ?? null,
                    checkedAt: result.checkedAt
                        ? new Date(result.checkedAt)
                        : new Date(),
                },
            );

            if (execution) {
                applied.push({
                    target: result.target,
                    monitorId: execution.monitorId,
                    status: execution.status,
                    changed: execution.changed,
                });
            }
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
        }

        return count;
    }

    // -- Helpers ---------------------------------------------------------

    private generateSecret(): string {
        return randomBytes(32).toString('hex');
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
            where: { id: probeId, organizationId: orgId },
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

    private toEntity(probe: {
        id: string;
        organizationId: string;
        name: string;
        provider: string;
        region: string;
        callbackUrl: string;
        secret: string;
        enabled: boolean;
        lastHeartbeat: Date | null;
        status: string;
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
            name: probe.name,
            provider: probe.provider,
            region: probe.region,
            callbackUrl: probe.callbackUrl,
            secret: probe.secret,
            enabled: probe.enabled,
            lastHeartbeat: probe.lastHeartbeat,
            status: probe.status,
            createdAt: probe.createdAt,
            updatedAt: probe.updatedAt,
            monitors,
            resultCount: probe._count?.results,
        });
    }
}
