import {
    Injectable,
    NotFoundException,
    BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { CreateMonitorDto, UpdateMonitorDto } from './dto';
import { MonitorEntity } from './entities';
import { MonitorType } from '../../generated/prisma/enums';
import type {
    MonitorModel,
    MonitorStateModel,
    ProjectModel,
} from '../../generated/prisma/models';
import { SystemProbeScheduler } from '../admin/system-probes/system-probe-scheduler';
import { QuotaService } from '../../shared/quota/quota.service';

/** A monitor row with its companion state row eagerly loaded. */
type MonitorWithState = MonitorModel & { state?: MonitorStateModel | null };

@Injectable()
export class MonitorsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly systemProbeScheduler: SystemProbeScheduler,
        private readonly quotaService: QuotaService,
    ) {}

    async create(projectId: string, dto: CreateMonitorDto) {
        const project = await this.ensureProjectExists(projectId);
        await this.quotaService.assertCanCreate(
            project.organizationId,
            'monitors',
        );
        await this.quotaService.assertIntervalAllowed(
            project.organizationId,
            dto.interval ?? 60,
        );
        this.validateTarget(dto.type, dto.target);
        this.validateSslConfig(dto.type, dto.target, dto.checkSsl ?? false);

        // The nested write creates the companion MonitorState row in the same
        // transaction as the monitor itself.
        const monitor = await this.prisma.monitor.create({
            data: {
                ...dto,
                organizationId: project.organizationId,
                projectId,
                state: { create: {} },
            },
            include: { state: true },
        });

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(monitor);
    }

    async findAll(projectId: string) {
        await this.ensureProjectExists(projectId);

        const monitors = await this.prisma.monitor.findMany({
            where: { projectId, deletedAt: null },
            include: { state: true },
            orderBy: { createdAt: 'desc' },
        });

        return monitors.map((m) => this.toEntity(m));
    }

    /** Cross-project listing used by the developer API. */
    async findAllByOrg(orgId: string) {
        const monitors = await this.prisma.monitor.findMany({
            where: { organizationId: orgId, deletedAt: null },
            include: { state: true },
            orderBy: { createdAt: 'desc' },
        });

        return monitors.map((m) => this.toEntity(m));
    }

    async findOne(projectId: string, monitorId: string) {
        const monitor = await this.ensureMonitorExists(projectId, monitorId);
        return this.toEntity(monitor);
    }

    async update(projectId: string, monitorId: string, dto: UpdateMonitorDto) {
        const existing = await this.ensureMonitorExists(projectId, monitorId);
        const nextType = dto.type ?? existing.type;
        const nextTarget = dto.target ?? existing.target;
        const nextCheckSsl = dto.checkSsl ?? existing.checkSsl;
        const targetChanged =
            nextType !== existing.type || nextTarget !== existing.target;
        const sslConfigChanged =
            targetChanged ||
            dto.checkSsl !== undefined ||
            dto.sslExpiryThreshold !== undefined;

        if (dto.interval !== undefined && dto.interval !== existing.interval) {
            await this.quotaService.assertIntervalAllowed(
                existing.organizationId,
                dto.interval,
            );
        }

        this.validateTarget(nextType, nextTarget);
        this.validateSslConfig(nextType, nextTarget, nextCheckSsl);

        const monitor = await this.prisma.monitor.update({
            where: { id: monitorId },
            data: {
                ...dto,
                state:
                    targetChanged || sslConfigChanged
                        ? {
                              upsert: {
                                  create: {},
                                  update: {
                                      status: 'UNKNOWN',
                                      failCount: 0,
                                      lastCheckAt: null,
                                      lastError: null,
                                      lastLatency: null,
                                      lastNotifiedStatus: null,
                                      sslExpiresAt: null,
                                      sslDaysRemaining: null,
                                      sslIssuer: null,
                                      sslSubject: null,
                                      sslLastNotifiedAt: null,
                                  },
                              },
                          }
                        : undefined,
            },
            include: { state: true },
        });

        if (targetChanged || dto.enabled !== undefined) {
            await this.systemProbeScheduler.rebalance();
        }

        return this.toEntity(monitor);
    }

    async pause(projectId: string, monitorId: string) {
        const monitor = await this.ensureMonitorExists(projectId, monitorId);

        if (!monitor.enabled) {
            throw new BadRequestException('Monitor is already paused');
        }

        const updated = await this.prisma.monitor.update({
            where: { id: monitorId },
            data: {
                enabled: false,
                state: {
                    upsert: {
                        create: { status: 'PAUSED' },
                        update: { status: 'PAUSED' },
                    },
                },
            },
            include: { state: true },
        });

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(updated);
    }

    async resume(projectId: string, monitorId: string) {
        const monitor = await this.ensureMonitorExists(projectId, monitorId);

        if (monitor.enabled) {
            throw new BadRequestException('Monitor is not paused');
        }

        const updated = await this.prisma.monitor.update({
            where: { id: monitorId },
            data: {
                enabled: true,
                // The real status is re-derived by the next check.
                state: {
                    upsert: { create: {}, update: { status: 'UNKNOWN' } },
                },
            },
            include: { state: true },
        });

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(updated);
    }

    async softDelete(projectId: string, monitorId: string) {
        await this.ensureMonitorExists(projectId, monitorId);

        const updated = await this.prisma.monitor.update({
            where: { id: monitorId },
            data: { deletedAt: new Date() },
            include: { state: true },
        });

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(updated);
    }

    async restore(projectId: string, monitorId: string) {
        await this.ensureProjectExists(projectId);

        const monitor = await this.prisma.monitor.findFirst({
            where: { id: monitorId, projectId },
            include: { state: true },
        });

        if (!monitor) {
            throw new NotFoundException('Monitor not found');
        }

        if (!monitor.deletedAt) {
            throw new BadRequestException('Monitor is not deleted');
        }

        const updated = await this.prisma.monitor.update({
            where: { id: monitorId },
            data: { deletedAt: null },
            include: { state: true },
        });

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(updated);
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private async ensureProjectExists(
        projectId: string,
    ): Promise<ProjectModel> {
        const project = await this.prisma.project.findFirst({
            where: {
                id: projectId,
                deletedAt: null,
                organization: { deletedAt: null },
            },
        });

        if (!project) {
            throw new NotFoundException('Project not found');
        }

        return project;
    }

    private validateTarget(type: MonitorType, target: string): void {
        if (type === MonitorType.HTTP) {
            this.validateHttpTarget(target);
            return;
        }

        if (type === MonitorType.TCP) {
            this.validateTcpTarget(target);
        }
    }

    private validateSslConfig(
        type: MonitorType,
        target: string,
        checkSsl: boolean,
    ): void {
        if (!checkSsl) return;

        if (type !== MonitorType.HTTP) {
            throw new BadRequestException(
                'SSL monitoring is only supported for HTTP monitors',
            );
        }

        const parsed = new URL(target);

        if (parsed.protocol !== 'https:') {
            throw new BadRequestException(
                'SSL monitoring requires an https:// target',
            );
        }
    }

    private validateHttpTarget(target: string): void {
        let parsed: URL;

        try {
            parsed = new URL(target);
        } catch {
            throw new BadRequestException(
                'HTTP monitor target must be a valid URL',
            );
        }

        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new BadRequestException(
                'HTTP monitor target must start with http:// or https://',
            );
        }
    }

    private validateTcpTarget(target: string): void {
        const lastColon = target.lastIndexOf(':');

        if (lastColon <= 0 || lastColon === target.length - 1) {
            throw new BadRequestException(
                'TCP monitor target must use host:port format',
            );
        }

        const host = target.slice(0, lastColon).trim();
        const port = Number(target.slice(lastColon + 1));

        if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
            throw new BadRequestException(
                'TCP monitor target must use host:port with port 1-65535',
            );
        }
    }

    private async ensureMonitorExists(
        projectId: string,
        monitorId: string,
    ): Promise<MonitorWithState> {
        const monitor = await this.prisma.monitor.findFirst({
            where: { id: monitorId, projectId, deletedAt: null },
            include: { state: true },
        });

        if (!monitor) {
            throw new NotFoundException('Monitor not found');
        }

        return monitor;
    }

    /** Flattens the companion state row into the monitor response. */
    private toEntity(monitor: MonitorWithState): MonitorEntity {
        const { state, ...rest } = monitor;

        return new MonitorEntity({
            ...rest,
            status: state?.status ?? 'UNKNOWN',
            failCount: state?.failCount ?? 0,
            lastCheckAt: state?.lastCheckAt ?? null,
            lastLatency: state?.lastLatency ?? null,
            lastError: state?.lastError ?? null,
            lastNotifiedStatus: state?.lastNotifiedStatus ?? null,
            sslExpiresAt: state?.sslExpiresAt ?? null,
            sslDaysRemaining: state?.sslDaysRemaining ?? null,
            sslIssuer: state?.sslIssuer ?? null,
            sslSubject: state?.sslSubject ?? null,
            sslLastNotifiedAt: state?.sslLastNotifiedAt ?? null,
        });
    }
}
