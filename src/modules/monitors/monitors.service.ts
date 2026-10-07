import {
    Injectable,
    NotFoundException,
    BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { CreateMonitorDto, UpdateMonitorDto } from './dto';
import { MonitorEntity } from './entities';
import { MonitorStatus, MonitorType } from '../../generated/prisma/enums';
import type {
    MonitorModel,
    MonitorStateModel,
    ProjectModel,
} from '../../generated/prisma/models';
import { SystemProbeScheduler } from '../admin/system-probes/system-probe-scheduler';
import { NotifierService } from '../notifier/notifier.service';
import { QuotaService } from '../../shared/quota/quota.service';

/** A monitor row with its companion state row and channel bindings loaded. */
type MonitorWithState = MonitorModel & {
    state?: MonitorStateModel | null;
    notificationChannels?: { channelId: string }[];
};

@Injectable()
export class MonitorsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly systemProbeScheduler: SystemProbeScheduler,
        private readonly quotaService: QuotaService,
        private readonly notifierService: NotifierService,
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

        const { notificationChannelIds, ...monitorData } = dto;
        await this.assertChannelsBelongToOrg(
            project.organizationId,
            notificationChannelIds,
        );

        // The nested write creates the companion MonitorState row and the
        // channel bindings in the same transaction as the monitor itself.
        const monitor = await this.prisma.monitor.create({
            data: {
                ...monitorData,
                organizationId: project.organizationId,
                projectId,
                state: { create: {} },
                notificationChannels: notificationChannelIds?.length
                    ? {
                          create: notificationChannelIds.map((channelId) => ({
                              channelId,
                          })),
                      }
                    : undefined,
            },
            include: { state: true, notificationChannels: true },
        });

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(monitor);
    }

    async findAll(projectId: string) {
        await this.ensureProjectExists(projectId);

        const monitors = await this.prisma.monitor.findMany({
            where: { projectId, deletedAt: null },
            include: { state: true, notificationChannels: true },
            orderBy: { createdAt: 'desc' },
        });

        return monitors.map((m) => this.toEntity(m));
    }

    /** Cross-project listing used by the developer API. */
    async findAllByOrg(orgId: string) {
        const monitors = await this.prisma.monitor.findMany({
            where: { organizationId: orgId, deletedAt: null },
            include: { state: true, notificationChannels: true },
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

        const { notificationChannelIds, ...monitorData } = dto;
        await this.assertChannelsBelongToOrg(
            existing.organizationId,
            notificationChannelIds,
        );

        const monitor = await this.prisma.monitor.update({
            where: { id: monitorId },
            data: {
                ...monitorData,
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
                ...(notificationChannelIds !== undefined
                    ? {
                          notificationChannels: {
                              deleteMany: {},
                              create: notificationChannelIds.map(
                                  (channelId) => ({ channelId }),
                              ),
                          },
                      }
                    : {}),
            },
            include: { state: true, notificationChannels: true },
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
            include: { state: true, notificationChannels: true },
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
            include: { state: true, notificationChannels: true },
        });

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(updated);
    }

    async softDelete(projectId: string, monitorId: string) {
        await this.ensureMonitorExists(projectId, monitorId);

        const updated = await this.prisma.monitor.update({
            where: { id: monitorId },
            data: { deletedAt: new Date() },
            include: { state: true, notificationChannels: true },
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
            include: { state: true, notificationChannels: true },
        });

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(updated);
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    /**
     * Sends a one-off test availability alert to the monitor's bound channels
     * (or the organization fallback) so operators can verify delivery without
     * waiting for a real outage. The payload is flagged as a test.
     */
    async sendTestAlert(projectId: string, monitorId: string) {
        const monitor = await this.ensureMonitorExists(projectId, monitorId);

        const window = monitor.availabilityWindow ?? 10;
        const threshold = monitor.availabilityThreshold ?? 90;

        const recent = await this.prisma.checkLog.findMany({
            where: { monitorId },
            orderBy: { checkedAt: 'desc' },
            take: window,
            select: { success: true },
        });

        const sampleSize = recent.length;
        const successes = recent.filter((log) => log.success).length;
        const availabilityPercent =
            sampleSize > 0
                ? Math.round((successes / sampleSize) * 10000) / 100
                : 0;

        const state = monitor.state ?? {
            status: MonitorStatus.UNKNOWN,
            failCount: 0,
            lastLatency: null,
            lastError: null,
            lastCheckAt: null,
        };

        const delivery = await this.notifierService.notifyAvailabilityAlert(
            monitor,
            state,
            {
                availabilityPercent,
                threshold,
                window,
                sampleSize,
                isTest: true,
            },
        );

        return {
            delivery,
            availabilityPercent,
            threshold,
            window,
            sampleSize,
        };
    }

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
            include: { state: true, notificationChannels: true },
        });

        if (!monitor) {
            throw new NotFoundException('Monitor not found');
        }

        return monitor;
    }

    /** Rejects channel IDs that are missing or belong to another organization. */
    private async assertChannelsBelongToOrg(
        organizationId: string,
        channelIds?: string[],
    ): Promise<void> {
        if (!channelIds || channelIds.length === 0) return;

        const uniqueIds = [...new Set(channelIds)];
        const found = await this.prisma.notificationChannel.count({
            where: { id: { in: uniqueIds }, organizationId },
        });

        if (found !== uniqueIds.length) {
            throw new BadRequestException(
                'One or more notification channels do not belong to this organization',
            );
        }
    }

    /** Flattens the companion state row into the monitor response. */
    private toEntity(monitor: MonitorWithState): MonitorEntity {
        const { state, notificationChannels, ...rest } = monitor;

        return new MonitorEntity({
            ...rest,
            notificationChannelIds:
                notificationChannels?.map((binding) => binding.channelId) ?? [],
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
