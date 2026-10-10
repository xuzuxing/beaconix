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
import type { MonitorPolicy } from '../../shared/quota/quota.service';
import { isIP } from 'node:net';
import { parseTcpTarget } from '../checker/checkers/tcp.checker';
import {
    CONFIG_VERSION,
    isDomain,
    validateMonitorConfig,
} from './monitor-config';
import type { MonitorConfig } from './monitor-config';
import {
    APPLICATION_MONITOR_TYPES,
    validateApplicationMonitorTarget,
} from './application-monitor-config';
import { MonitorSecretsService } from './monitor-secrets.service';
import type { JsonValue } from '../../generated/prisma/internal/prismaNamespace';

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
        private readonly secrets: MonitorSecretsService,
    ) {}

    async create(projectId: string, dto: CreateMonitorDto) {
        this.rejectNullFields(dto);
        const project = await this.ensureProjectExists(projectId);
        await this.quotaService.assertCanCreate(
            project.organizationId,
            'monitors',
        );
        await this.quotaService.assertIntervalAllowed(
            project.organizationId,
            dto.interval ?? 60,
        );
        await this.quotaService.assertMonitorTypeAllowed(
            project.organizationId,
            dto.type,
        );
        const config = validateMonitorConfig(dto.type, dto.config);
        const sealed = this.secrets.seal(config, {
            organizationId: project.organizationId,
            type: dto.type,
            target: dto.target,
        });
        this.validateTarget(dto.type, dto.target, config);
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
                config: sealed.config,
                ...(sealed.credentialsEnc
                    ? { credentialsEnc: sealed.credentialsEnc }
                    : {}),
                ...(dto.timeout === undefined &&
                APPLICATION_MONITOR_TYPES.includes(dto.type)
                    ? { timeout: 10000 }
                    : {}),
                configVersion: CONFIG_VERSION,
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
        const project = await this.ensureProjectExists(projectId);

        const monitors = await this.prisma.monitor.findMany({
            where: { projectId, deletedAt: null },
            include: { state: true, notificationChannels: true },
            orderBy: { createdAt: 'desc' },
        });

        const policy = await this.quotaService.getMonitorPolicy(
            project.organizationId,
        );
        return Promise.all(monitors.map((m) => this.toEntity(m, policy)));
    }

    /** Cross-project listing used by the developer API. */
    async findAllByOrg(orgId: string) {
        const monitors = await this.prisma.monitor.findMany({
            where: { organizationId: orgId, deletedAt: null },
            include: { state: true, notificationChannels: true },
            orderBy: { createdAt: 'desc' },
        });

        const policy = await this.quotaService.getMonitorPolicy(orgId);
        return Promise.all(monitors.map((m) => this.toEntity(m, policy)));
    }

    async findOne(projectId: string, monitorId: string) {
        const monitor = await this.ensureMonitorExists(projectId, monitorId);
        return this.toEntity(monitor);
    }

    async update(projectId: string, monitorId: string, dto: UpdateMonitorDto) {
        this.rejectNullFields(dto);
        const existing = await this.ensureMonitorExists(projectId, monitorId);
        const nextType = dto.type ?? existing.type;
        const nextTarget = dto.target ?? existing.target;
        const nextCheckSsl = dto.checkSsl ?? existing.checkSsl;
        if (
            nextTarget !== existing.target &&
            existing.credentialsEnc &&
            dto.config === undefined
        ) {
            throw new BadRequestException(
                'Changing a credentialed target requires a complete config with credentials re-entered',
            );
        }
        if (
            dto.type !== undefined &&
            dto.type !== existing.type &&
            dto.config === undefined
        ) {
            throw new BadRequestException(
                'A type change requires a complete config',
            );
        }
        const config = validateMonitorConfig(
            nextType,
            dto.config !== undefined ? dto.config : this.secrets.open(existing),
        );
        const targetChanged =
            nextType !== existing.type || nextTarget !== existing.target;
        let configChanged = false;
        if (dto.config !== undefined) {
            try {
                const previousConfig = validateMonitorConfig(
                    existing.type,
                    this.secrets.open(existing),
                );
                configChanged =
                    JSON.stringify(config) !== JSON.stringify(previousConfig);
            } catch {
                // An explicit replacement can repair invalid persisted config.
                configChanged = true;
            }
        }
        const definitionChanged =
            targetChanged ||
            configChanged ||
            (
                [
                    'timeout',
                    'expectedStatus',
                    'failureThreshold',
                    'interval',
                    'checkSsl',
                    'sslExpiryThreshold',
                    'availabilityEnabled',
                    'availabilityThreshold',
                    'availabilityWindow',
                ] as const
            ).some(
                (field) =>
                    dto[field] !== undefined && dto[field] !== existing[field],
            );
        const lifecycleChanged =
            dto.enabled !== undefined && dto.enabled !== existing.enabled;

        if (dto.interval !== undefined && dto.interval !== existing.interval) {
            await this.quotaService.assertIntervalAllowed(
                existing.organizationId,
                dto.interval,
            );
        }
        if (
            nextType !== existing.type ||
            (dto.enabled === true && !existing.enabled)
        ) {
            await this.quotaService.assertMonitorTypeAllowed(
                existing.organizationId,
                nextType,
            );
            await this.quotaService.assertIntervalAllowed(
                existing.organizationId,
                dto.interval ?? existing.interval,
            );
        }

        this.validateTarget(nextType, nextTarget, config);
        this.validateSslConfig(nextType, nextTarget, nextCheckSsl);
        const sealed = this.secrets.seal(config, {
            organizationId: existing.organizationId,
            type: nextType,
            target: nextTarget,
        });

        const { notificationChannelIds, ...monitorData } = dto;
        await this.assertChannelsBelongToOrg(
            existing.organizationId,
            notificationChannelIds,
        );

        const monitor = await this.prisma.monitor.update({
            where: {
                id: monitorId,
                revision: existing.revision,
                deletedAt: null,
            },
            data: {
                ...monitorData,
                config: sealed.config,
                ...(dto.config !== undefined || existing.credentialsEnc
                    ? { credentialsEnc: sealed.credentialsEnc }
                    : {}),
                ...(definitionChanged || lifecycleChanged
                    ? {
                          revision: { increment: 1 },
                      }
                    : {}),
                state:
                    definitionChanged || lifecycleChanged
                        ? {
                              upsert: {
                                  create: {
                                      status:
                                          (dto.enabled ?? existing.enabled)
                                              ? 'UNKNOWN'
                                              : 'PAUSED',
                                  },
                                  update: {
                                      status:
                                          (dto.enabled ?? existing.enabled)
                                              ? 'UNKNOWN'
                                              : 'PAUSED',
                                      failCount: 0,
                                      lastCheckAt: null,
                                      lastLocalCheckAt: null,
                                      executionBlockedReason: null,
                                      lastError: null,
                                      lastLatency: null,
                                      lastNotifiedStatus: null,
                                      sslExpiresAt: null,
                                      sslDaysRemaining: null,
                                      sslIssuer: null,
                                      sslSubject: null,
                                      sslLastNotifiedAt: null,
                                      availabilityAlertActive: false,
                                      availabilityAlertPendingId: null,
                                      lastAvailabilityAlertAt: null,
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
            where: { id: monitorId, revision: monitor.revision },
            data: {
                enabled: false,
                revision: { increment: 1 },
                state: {
                    upsert: {
                        create: { status: 'PAUSED' },
                        update: {
                            status: 'PAUSED',
                            availabilityAlertPendingId: null,
                        },
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
        await this.quotaService.assertMonitorTypeAllowed(
            monitor.organizationId,
            monitor.type,
        );
        await this.quotaService.assertIntervalAllowed(
            monitor.organizationId,
            monitor.interval,
        );

        const updated = await this.prisma.monitor.update({
            where: { id: monitorId, revision: monitor.revision },
            data: {
                enabled: true,
                revision: { increment: 1 },
                // The real status is re-derived by the next check.
                state: {
                    upsert: {
                        create: {},
                        update: {
                            status: 'UNKNOWN',
                            failCount: 0,
                            lastLocalCheckAt: null,
                            executionBlockedReason: null,
                            availabilityAlertActive: false,
                            availabilityAlertPendingId: null,
                        },
                    },
                },
            },
            include: { state: true, notificationChannels: true },
        });

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(updated);
    }

    async softDelete(projectId: string, monitorId: string) {
        const monitor = await this.ensureMonitorExists(projectId, monitorId);

        const updated = await this.prisma.monitor.update({
            where: { id: monitorId, revision: monitor.revision },
            data: { deletedAt: new Date(), revision: { increment: 1 } },
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
        await this.quotaService.assertCanCreate(
            monitor.organizationId,
            'monitors',
        );
        await this.quotaService.assertMonitorTypeAllowed(
            monitor.organizationId,
            monitor.type,
        );
        await this.quotaService.assertIntervalAllowed(
            monitor.organizationId,
            monitor.interval,
        );

        const updated = await this.prisma.monitor.update({
            where: { id: monitorId, revision: monitor.revision },
            data: {
                deletedAt: null,
                revision: { increment: 1 },
                state: {
                    upsert: {
                        create: {
                            status: monitor.enabled ? 'UNKNOWN' : 'PAUSED',
                        },
                        update: {
                            status: monitor.enabled ? 'UNKNOWN' : 'PAUSED',
                            failCount: 0,
                            lastLocalCheckAt: null,
                            executionBlockedReason: null,
                            availabilityAlertActive: false,
                            availabilityAlertPendingId: null,
                        },
                    },
                },
            },
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
            where: { monitorId, evaluated: true, revision: monitor.revision },
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

    private validateTarget(
        type: MonitorType,
        target: string,
        config?: MonitorConfig,
    ): void {
        if (APPLICATION_MONITOR_TYPES.includes(type)) {
            validateApplicationMonitorTarget(type, target, config);
            return;
        }
        if (type === MonitorType.HTTP) {
            this.validateHttpTarget(target);
            return;
        }

        if (type === MonitorType.TCP) {
            this.validateTcpTarget(target);
            return;
        }
        if (type === MonitorType.DNS && (!isDomain(target) || isIP(target))) {
            throw new BadRequestException('DNS target must be a domain name');
        }
        if (type === MonitorType.PING && !isIP(target) && !isDomain(target)) {
            throw new BadRequestException(
                'PING target must be a hostname or IP',
            );
        }
    }

    private rejectNullFields(dto: CreateMonitorDto | UpdateMonitorDto): void {
        if (Object.values(dto).some((value) => value === null)) {
            throw new BadRequestException('Monitor fields cannot be null');
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
        if (!parseTcpTarget(target)) {
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
    private async toEntity(
        monitor: MonitorWithState,
        policy?: MonitorPolicy,
    ): Promise<MonitorEntity> {
        const { state, notificationChannels, credentialsEnc, ...rest } =
            monitor;
        const eligibility = await this.quotaService.monitorEligibility(
            monitor.organizationId,
            monitor.type,
            monitor.interval,
            policy,
        );
        const reason = !monitor.enabled
            ? 'PAUSED'
            : (eligibility.reason ?? state?.executionBlockedReason ?? null);

        return new MonitorEntity({
            ...rest,
            config: this.secrets.publicConfig(monitor.config) as JsonValue,
            hasCredentials: !!credentialsEnc,
            executionEligible: reason === null,
            executionBlockedReason: reason,
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
