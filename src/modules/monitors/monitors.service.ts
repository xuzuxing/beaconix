import {
    Injectable,
    NotFoundException,
    BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { CreateMonitorDto, SetMonitorProbesDto, UpdateMonitorDto } from './dto';
import { MonitorEntity, MonitorProbeEntity } from './entities';
import {
    MonitorStatus,
    MonitorType,
    ProbeScope,
} from '../../generated/prisma/enums';
import type {
    MonitorModel,
    MonitorStateModel,
    ProjectModel,
} from '../../generated/prisma/models';
import { SystemProbeScheduler } from '../admin/system-probes/system-probe-scheduler';
import { NotifierService } from '../notifier/notifier.service';
import {
    QuotaService,
    probeAssignmentLimit,
} from '../../shared/quota/quota.service';
import type { MonitorPolicy } from '../../shared/quota/quota.service';
import { isIP } from 'node:net';
import { parseTcpTarget } from '../checker/checkers/tcp.checker';
import { assertLiteralPublicAddress } from '../checker/checkers/network-guard';
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
import type {
    InputJsonValue,
    JsonValue,
} from '../../generated/prisma/internal/prismaNamespace';
import { ProjectAccessService } from '../../common/authorization/project-access.service';
import type { AccessPrincipal } from '../../common/authorization/access.types';
import type { AccessDb } from '../../common/authorization/access-locks';
import {
    monitoringProjection,
    sanitizeMonitoringTarget,
} from '../../common/authorization/monitoring-projection';

/** Columns of an assigned probe returned by the monitor endpoints. */
const PROBE_SUMMARY_SELECT = {
    id: true,
    name: true,
    provider: true,
    region: true,
    status: true,
    enabled: true,
    lastHeartbeat: true,
} as const;

/** Single-monitor reads always carry the state row, channels and probes. */
const MONITOR_INCLUDE = {
    state: true,
    notificationChannels: true,
    probes: { include: { probe: { select: PROBE_SUMMARY_SELECT } } },
} as const;

/** A monitor row with its companion state row and channel bindings loaded. */
type MonitorWithState = MonitorModel & {
    state?: MonitorStateModel | null;
    notificationChannels?: { channelId: string }[];
    probes?: {
        probe: {
            id: string;
            name: string;
            provider: string;
            region: string;
            status: string;
            enabled: boolean;
            lastHeartbeat: Date | null;
        };
    }[];
};

@Injectable()
export class MonitorsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly systemProbeScheduler: SystemProbeScheduler,
        private readonly quotaService: QuotaService,
        private readonly notifierService: NotifierService,
        private readonly secrets: MonitorSecretsService,
        private readonly access: ProjectAccessService,
    ) {}

    async create(
        projectId: string,
        dto: CreateMonitorDto,
        principal: AccessPrincipal,
    ) {
        await this.access.project(principal, projectId, 'monitor.manage');
        this.rejectNullFields(dto);
        const project = await this.ensureProjectExists(projectId);
        const config = validateMonitorConfig(dto.type, dto.config);
        const sealed = this.secrets.seal(config, {
            organizationId: project.organizationId,
            type: dto.type,
            target: dto.target,
        });
        this.validateTarget(dto.type, dto.target, config);
        this.validateSslConfig(dto.type, dto.target, dto.checkSsl ?? false);

        const { notificationChannelIds, probeIds, ...monitorData } = dto;
        await this.assertChannelsBelongToOrg(
            project.organizationId,
            notificationChannelIds,
        );
        const probesToAssign = await this.assertProbesBelongToOrg(
            project.organizationId,
            probeIds,
        );

        // The nested write creates the companion MonitorState row, the
        // channel bindings and the probe assignments in the same
        // transaction as the monitor itself.
        const monitor = await this.access.withProject(
            principal,
            projectId,
            'monitor.manage',
            async (tx) => {
                // Count inside the write transaction (the org row is already
                // locked by `withProject`) so parallel creates cannot all pass.
                const plan =
                    await this.quotaService.assertCanCreateInTransaction(
                        project.organizationId,
                        'monitors',
                        tx,
                    );
                await this.quotaService.assertIntervalAllowed(
                    project.organizationId,
                    dto.interval ?? 60,
                    tx,
                    plan,
                );
                await this.quotaService.assertMonitorTypeAllowed(
                    project.organizationId,
                    dto.type,
                    tx,
                    plan,
                );
                await this.quotaService.assertProbesAssignable(
                    project.organizationId,
                    probesToAssign.length,
                    plan,
                );
                await this.assertChannelsBelongToOrg(
                    project.organizationId,
                    notificationChannelIds,
                    tx,
                );
                await this.assertProbesBelongToOrg(
                    project.organizationId,
                    probesToAssign,
                    tx,
                );
                return tx.monitor.create({
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
                                  create: notificationChannelIds.map(
                                      (channelId) => ({
                                          channelId,
                                      }),
                                  ),
                              }
                            : undefined,
                        probes: probesToAssign.length
                            ? {
                                  create: probesToAssign.map((probeId) => ({
                                      probeId,
                                  })),
                              }
                            : undefined,
                    },
                    include: MONITOR_INCLUDE,
                });
            },
        );

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(monitor);
    }

    async findAll(projectId: string, principal: AccessPrincipal) {
        const access = await this.access.project(
            principal,
            projectId,
            'monitor.read',
        );
        const project = await this.ensureProjectExists(projectId);

        const monitors = await this.prisma.monitor.findMany({
            where: { projectId, deletedAt: null },
            include: { state: true, notificationChannels: true },
            orderBy: { createdAt: 'desc' },
        });

        const policy = await this.quotaService.getMonitorPolicy(
            project.organizationId,
        );
        return monitoringProjection(
            await Promise.all(monitors.map((m) => this.toEntity(m, policy))),
            access.effectiveRole,
        );
    }

    /** Cross-project listing used by the developer API. */
    async findAllByOrg(orgId: string, principal: AccessPrincipal) {
        const project = await this.access.projectFilter(principal, orgId);
        const monitors = await this.prisma.monitor.findMany({
            where: { organizationId: orgId, deletedAt: null, project },
            include: { state: true, notificationChannels: true },
            orderBy: { createdAt: 'desc' },
        });

        const policy = await this.quotaService.getMonitorPolicy(orgId);
        const roles = new Map<string, 'ADMIN' | 'MEMBER' | 'VIEWER'>();
        for (const projectId of new Set(
            monitors.map((monitor) => monitor.projectId),
        )) {
            roles.set(
                projectId,
                (
                    await this.access.project(
                        principal,
                        projectId,
                        'monitor.read',
                        orgId,
                    )
                ).effectiveRole,
            );
        }
        return Promise.all(
            monitors.map(async (m) =>
                monitoringProjection(
                    await this.toEntity(m, policy),
                    roles.get(m.projectId)!,
                ),
            ),
        );
    }

    async findOne(
        projectId: string,
        monitorId: string,
        principal: AccessPrincipal,
    ) {
        const access = await this.access.project(
            principal,
            projectId,
            'monitor.read',
        );
        const monitor = await this.ensureMonitorExists(projectId, monitorId);
        return monitoringProjection(
            await this.toEntity(monitor),
            access.effectiveRole,
        );
    }

    async update(
        projectId: string,
        monitorId: string,
        dto: UpdateMonitorDto,
        principal: AccessPrincipal,
    ) {
        await this.access.project(principal, projectId, 'monitor.manage');
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
                    'probeSuccessRatio',
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
        const sealed =
            configChanged || targetChanged
                ? this.secrets.seal(config, {
                      organizationId: existing.organizationId,
                      type: nextType,
                      target: nextTarget,
                  })
                : {
                      config: existing.config as InputJsonValue,
                      credentialsEnc: existing.credentialsEnc,
                  };

        const { notificationChannelIds, probeIds, ...monitorData } = dto;
        await this.assertChannelsBelongToOrg(
            existing.organizationId,
            notificationChannelIds,
        );
        const probesToAssign =
            probeIds === undefined
                ? undefined
                : await this.assertProbesBelongToOrg(
                      existing.organizationId,
                      probeIds,
                  );
        if (probesToAssign) {
            await this.quotaService.assertProbesAssignable(
                existing.organizationId,
                probesToAssign.length,
            );
        }

        const monitor = await this.access.withProject(
            principal,
            projectId,
            'monitor.manage',
            async (tx) => {
                await this.ensureMonitorExists(projectId, monitorId, tx);
                await this.assertChannelsBelongToOrg(
                    existing.organizationId,
                    notificationChannelIds,
                    tx,
                );
                await this.assertProbesBelongToOrg(
                    existing.organizationId,
                    probesToAssign,
                    tx,
                );
                return tx.monitor.update({
                    where: {
                        id: monitorId,
                        projectId,
                        organizationId: existing.organizationId,
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
                                                  (dto.enabled ??
                                                  existing.enabled)
                                                      ? 'UNKNOWN'
                                                      : 'PAUSED',
                                          },
                                          update: {
                                              status:
                                                  (dto.enabled ??
                                                  existing.enabled)
                                                      ? 'UNKNOWN'
                                                      : 'PAUSED',
                                              failCount: 0,
                                              connectivityFailCount: 0,
                                              lastAppliedObservationAt: null,
                                              lastAppliedObservationId: null,
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
                        ...(probesToAssign
                            ? {
                                  probes: {
                                      deleteMany: {},
                                      create: probesToAssign.map((probeId) => ({
                                          probeId,
                                      })),
                                  },
                              }
                            : {}),
                    },
                    include: MONITOR_INCLUDE,
                });
            },
        );

        if (
            targetChanged ||
            dto.enabled !== undefined ||
            probesToAssign !== undefined
        ) {
            await this.systemProbeScheduler.rebalance();
        }

        return this.toEntity(monitor);
    }

    /**
     * Replaces the tenant probes assigned to one monitor (set semantics).
     *
     * Bound probes vote on every check: the success verdict is the percentage
     * of bound, enabled and online probes that reported success, so clearing
     * the set hands the verdict back to the local checker. The number of probes
     * is capped by the plan (`maxProbesPerMonitor`, clamped by `maxProbes`).
     */
    async setProbes(
        projectId: string,
        monitorId: string,
        dto: SetMonitorProbesDto,
        principal: AccessPrincipal,
    ) {
        await this.access.project(principal, projectId, 'monitor.manage');
        const monitor = await this.ensureMonitorExists(projectId, monitorId);
        const probeIds = await this.assertProbesBelongToOrg(
            monitor.organizationId,
            dto.probeIds,
        );
        await this.quotaService.assertProbesAssignable(
            monitor.organizationId,
            probeIds.length,
        );

        const updated = await this.access.withProject(
            principal,
            projectId,
            'monitor.manage',
            async (tx) => {
                await this.ensureMonitorExists(projectId, monitorId, tx);
                await this.assertProbesBelongToOrg(
                    monitor.organizationId,
                    probeIds,
                    tx,
                );
                await tx.monitorProbe.deleteMany({ where: { monitorId } });
                if (probeIds.length > 0) {
                    await tx.monitorProbe.createMany({
                        data: probeIds.map((probeId) => ({
                            monitorId,
                            probeId,
                        })),
                        skipDuplicates: true,
                    });
                }
                return tx.monitor.findFirstOrThrow({
                    where: { id: monitorId, projectId, deletedAt: null },
                    include: MONITOR_INCLUDE,
                });
            },
        );

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(updated);
    }

    async pause(
        projectId: string,
        monitorId: string,
        principal: AccessPrincipal,
    ) {
        await this.access.project(principal, projectId, 'monitor.manage');
        const monitor = await this.ensureMonitorExists(projectId, monitorId);

        if (!monitor.enabled) {
            throw new BadRequestException('Monitor is already paused');
        }

        const updated = await this.access.withProject(
            principal,
            projectId,
            'monitor.manage',
            (tx) =>
                tx.monitor.update({
                    where: {
                        id: monitorId,
                        projectId,
                        deletedAt: null,
                        revision: monitor.revision,
                    },
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
                    include: MONITOR_INCLUDE,
                }),
        );

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(updated);
    }

    async resume(
        projectId: string,
        monitorId: string,
        principal: AccessPrincipal,
    ) {
        await this.access.project(principal, projectId, 'monitor.manage');
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

        const updated = await this.access.withProject(
            principal,
            projectId,
            'monitor.manage',
            (tx) =>
                tx.monitor.update({
                    where: {
                        id: monitorId,
                        projectId,
                        deletedAt: null,
                        revision: monitor.revision,
                    },
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
                                    connectivityFailCount: 0,
                                    lastAppliedObservationAt: null,
                                    lastAppliedObservationId: null,
                                    lastLocalCheckAt: null,
                                    executionBlockedReason: null,
                                    availabilityAlertActive: false,
                                    availabilityAlertPendingId: null,
                                },
                            },
                        },
                    },
                    include: MONITOR_INCLUDE,
                }),
        );

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(updated);
    }

    async softDelete(
        projectId: string,
        monitorId: string,
        principal: AccessPrincipal,
    ) {
        await this.access.project(principal, projectId, 'monitor.manage');
        const monitor = await this.ensureMonitorExists(projectId, monitorId);

        const updated = await this.access.withProject(
            principal,
            projectId,
            'monitor.manage',
            (tx) =>
                tx.monitor.update({
                    where: {
                        id: monitorId,
                        projectId,
                        deletedAt: null,
                        revision: monitor.revision,
                    },
                    data: { deletedAt: new Date(), revision: { increment: 1 } },
                    include: MONITOR_INCLUDE,
                }),
        );

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(updated);
    }

    async restore(
        projectId: string,
        monitorId: string,
        principal: AccessPrincipal,
    ) {
        await this.access.project(principal, projectId, 'monitor.restore');
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
        const updated = await this.access.withProject(
            principal,
            projectId,
            'monitor.restore',
            async (tx) => {
                // Keep the tenant lock through both the quota check and the
                // restore. A separate assertion transaction releases it early.
                const plan =
                    await this.quotaService.assertCanCreateInTransaction(
                        monitor.organizationId,
                        'monitors',
                        tx,
                    );
                await this.quotaService.assertMonitorTypeAllowed(
                    monitor.organizationId,
                    monitor.type,
                    tx,
                    plan,
                );
                await this.quotaService.assertIntervalAllowed(
                    monitor.organizationId,
                    monitor.interval,
                    tx,
                    plan,
                );
                return tx.monitor.update({
                    where: {
                        id: monitorId,
                        projectId,
                        deletedAt: { not: null },
                        revision: monitor.revision,
                    },
                    data: {
                        deletedAt: null,
                        quotaGraceEndsAt: null,
                        configRevision: { increment: 1 },
                        revision: { increment: 1 },
                        state: {
                            upsert: {
                                create: {
                                    status: monitor.enabled
                                        ? 'UNKNOWN'
                                        : 'PAUSED',
                                },
                                update: {
                                    status: monitor.enabled
                                        ? 'UNKNOWN'
                                        : 'PAUSED',
                                    failCount: 0,
                                    connectivityFailCount: 0,
                                    lastAppliedObservationAt: null,
                                    lastAppliedObservationId: null,
                                    lastLocalCheckAt: null,
                                    executionBlockedReason: null,
                                    availabilityAlertActive: false,
                                    availabilityAlertPendingId: null,
                                },
                            },
                        },
                    },
                    include: MONITOR_INCLUDE,
                });
            },
        );

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(updated);
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    /**
     * Sends a one-off test availability alert to the monitor's bound channels
     * (or the organization fallback) so operators can verify delivery without
     * waiting for a real outage. The payload is flagged as a test.
     */
    async sendTestAlert(
        projectId: string,
        monitorId: string,
        principal: AccessPrincipal,
    ) {
        const monitor = await this.access.withProject(
            principal,
            projectId,
            'monitor.test-alert',
            async (tx) => {
                const monitor = await this.ensureMonitorExists(
                    projectId,
                    monitorId,
                    tx,
                );
                await tx.auditLog.create({
                    data: {
                        actorId:
                            principal.type === 'USER' ? principal.userId : null,
                        organizationId: monitor.organizationId,
                        projectId,
                        entity: 'Monitor',
                        entityId: monitorId,
                        action: 'UPDATE',
                        after: {
                            action: 'monitor.test-alert',
                            principal:
                                principal.type === 'SYSTEM'
                                    ? { type: 'SYSTEM' }
                                    : principal,
                        },
                    },
                });
                return monitor;
            },
        );

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
        if (parsed.username || parsed.password) {
            throw new BadRequestException(
                'HTTP monitor target must not contain URL credentials',
            );
        }

        this.assertPublicLiteral(parsed.hostname);
    }

    /**
     * Literal private addresses are rejected at save time so the user gets a
     * clear error instead of a monitor that can never succeed. Domains are vetted
     * at execution time, where the resolution happens anyway.
     */
    private assertPublicLiteral(hostname: string): void {
        const host = hostname.replace(/^\[|\]$/g, '');
        const verdict = assertLiteralPublicAddress(host);

        if (!verdict.ok) {
            throw new BadRequestException(
                `Monitor target must be a public address (${verdict.reason}); use a probe to monitor internal hosts`,
            );
        }
    }

    private validateTcpTarget(target: string): void {
        const parsed = parseTcpTarget(target);

        if (!parsed) {
            throw new BadRequestException(
                'TCP monitor target must use host:port with port 1-65535',
            );
        }

        this.assertPublicLiteral(parsed.host);
    }

    private async ensureMonitorExists(
        projectId: string,
        monitorId: string,
        db: AccessDb = this.prisma,
    ): Promise<MonitorWithState> {
        const monitor = await db.monitor.findFirst({
            where: { id: monitorId, projectId, deletedAt: null },
            include: MONITOR_INCLUDE,
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
        db: AccessDb = this.prisma,
    ): Promise<void> {
        if (!channelIds || channelIds.length === 0) return;

        const uniqueIds = [...new Set(channelIds)];
        const found = await db.notificationChannel.count({
            where: { id: { in: uniqueIds }, organizationId },
        });

        if (found !== uniqueIds.length) {
            throw new BadRequestException(
                'One or more notification channels do not belong to this organization',
            );
        }
    }

    /**
     * Normalises a probe ID list and rejects probes that are missing, belong to
     * another organization, or are system probes (those are scheduled by the
     * SystemProbeScheduler, never assigned by hand).
     */
    private async assertProbesBelongToOrg(
        organizationId: string,
        probeIds?: string[],
        db: AccessDb = this.prisma,
    ): Promise<string[]> {
        if (!probeIds || probeIds.length === 0) return [];

        const uniqueIds = [...new Set(probeIds)];
        const found = await db.probe.count({
            where: {
                id: { in: uniqueIds },
                organizationId,
                scope: ProbeScope.TENANT,
            },
        });

        if (found !== uniqueIds.length) {
            throw new BadRequestException(
                'One or more probes do not belong to this organization',
            );
        }

        return uniqueIds;
    }

    /** Flattens the companion state row into the monitor response. */
    private async toEntity(
        monitor: MonitorWithState,
        policy?: MonitorPolicy,
    ): Promise<MonitorEntity> {
        const { state, notificationChannels, probes, credentialsEnc, ...rest } =
            monitor;
        const effectivePolicy =
            policy ??
            (await this.quotaService.getMonitorPolicy(monitor.organizationId));
        const eligibility = await this.quotaService.monitorEligibility(
            monitor.organizationId,
            monitor.type,
            monitor.interval,
            effectivePolicy,
            monitor.id,
        );
        const reason = !monitor.enabled
            ? 'PAUSED'
            : (eligibility.reason ?? state?.executionBlockedReason ?? null);

        return new MonitorEntity({
            ...rest,
            target: sanitizeMonitoringTarget(monitor.target),
            config: this.secrets.publicConfig(monitor.config) as JsonValue,
            hasCredentials: !!credentialsEnc,
            executionEligible: reason === null,
            executionBlockedReason: reason,
            notificationChannelIds:
                notificationChannels?.map((binding) => binding.channelId) ?? [],
            // List endpoints omit the binding so they stay a single query;
            // single-monitor endpoints always include it.
            probes: probes?.map(
                (binding) => new MonitorProbeEntity(binding.probe),
            ),
            maxProbes: probeAssignmentLimit(effectivePolicy),
            status:
                reason === 'MONITOR_QUOTA_EXCEEDED'
                    ? 'UNKNOWN'
                    : (state?.status ?? 'UNKNOWN'),
            failCount: state?.failCount ?? 0,
            lastCheckAt: state?.lastCheckAt ?? null,
            lastLatency: state?.lastLatency ?? null,
            lastError: state?.lastError
                ? monitoringProjection(state.lastError, 'ADMIN')
                : null,
            lastNotifiedStatus: state?.lastNotifiedStatus ?? null,
            sslExpiresAt: state?.sslExpiresAt ?? null,
            sslDaysRemaining: state?.sslDaysRemaining ?? null,
            sslIssuer: state?.sslIssuer ?? null,
            sslSubject: state?.sslSubject ?? null,
            sslLastNotifiedAt: state?.sslLastNotifiedAt ?? null,
        });
    }
}
