import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleInit,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toIsoString } from '../../common/utils/date.util';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
    NotificationType,
} from '../../generated/prisma/enums';
import type { Prisma } from '../../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { ADMIN_ROLES } from '../notifications/notification-event';
import type { InputJsonValue } from '../../generated/prisma/internal/prismaNamespace';
import { SystemProbeScheduler } from '../admin/system-probes/system-probe-scheduler';
import { QuotaService } from '../../shared/quota/quota.service';
import { CheckerService } from '../checker/checker.service';
import { hashSecret, secretPrefixOf } from './probe-secret.util';
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

/**
 * Grace window during which a rotated secret keeps working alongside the new
 * one, so a probe that has not yet picked up the new secret does not go dark.
 */
const PROBE_SECRET_ROTATION_GRACE_HOURS = 24;

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
    configRevision: true,
    organizationId: true,
    projectId: true,
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
        configRevision: number;
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
        private readonly notifications: NotificationsService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.probeOfflineSweep,
            pattern: SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.probeOfflineSweep],
            handler: () => this.markStaleProbesOffline(),
        });
        this.registry.register({
            name: 'probe-ingest-sweep',
            pattern: '* * * * *',
            handler: () => this.applyPendingResults(),
        });
    }

    async create(
        orgId: string,
        dto: CreateProbeDto,
        actorId?: string,
    ): Promise<ProbeEntity> {
        await this.quotaService.assertFeatureAllowed(orgId, 'tenantProbe');
        await this.quotaService.assertCanCreate(orgId, 'probes');

        const secret = this.generateSecret('tnt');

        const probe = await this.prisma.$transaction(async (tx) => {
            const created = await tx.probe.create({
                data: {
                    organizationId: orgId,
                    scope: ProbeScope.TENANT,
                    name: dto.name,
                    provider: dto.provider,
                    region: dto.region,
                    callbackUrl: dto.callbackUrl,
                    enabled: dto.enabled ?? true,
                    secrets: { create: this.secretRecord(secret) },
                },
            });
            await this.credentialNotice(
                orgId,
                created.id,
                NotificationType.PROBE_ENROLLED,
                'A probe was enrolled',
                `probe-enrolled:${created.id}`,
                tx,
                actorId,
            );
            return created;
        });

        // The plaintext secret is handed back exactly once, on this response.
        return this.toEntity(probe, secret);
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
    async remove(
        orgId: string,
        probeId: string,
        actorId?: string,
    ): Promise<void> {
        await this.ensureProbeExists(orgId, probeId);

        await this.prisma.$transaction(async (tx) => {
            await tx.probe.delete({ where: { id: probeId } });
            await this.credentialNotice(
                orgId,
                probeId,
                NotificationType.PROBE_CREDENTIAL_REVOKED,
                'A probe was removed and its credentials revoked',
                `probe-removed:${probeId}`,
                tx,
                actorId,
            );
        });
        await this.systemProbeScheduler.rebalance();
    }

    /**
     * Issues a new secret while the previous one keeps working for a grace
     * window (smooth rotation): the probe stays online and picks up the new
     * secret on its own schedule instead of being knocked offline.
     */
    async rotateSecret(
        orgId: string,
        probeId: string,
        actorId?: string,
    ): Promise<ProbeEntity> {
        await this.ensureProbeExists(orgId, probeId);

        const secret = this.generateSecret('tnt');
        const graceDeadline = new Date(
            Date.now() + PROBE_SECRET_ROTATION_GRACE_HOURS * 60 * 60 * 1000,
        );

        const probe = await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM probes WHERE id = ${probeId} FOR UPDATE`;
            // Give the secrets currently in force an expiry rather than
            // revoking them, so an un-updated probe keeps working meanwhile.
            await tx.probeSecret.updateMany({
                where: { probeId, revokedAt: null, expiresAt: null },
                data: { expiresAt: graceDeadline },
            });

            const rotated = await tx.probe.update({
                where: { id: probeId },
                data: { secrets: { create: this.secretRecord(secret) } },
                include: {
                    monitors: {
                        include: { monitor: { select: MONITOR_SELECT } },
                    },
                    _count: { select: { results: true } },
                },
            });
            await this.credentialNotice(
                orgId,
                probeId,
                NotificationType.PROBE_SECRET_ROTATED,
                'A probe credential was rotated',
                `probe-secret-rotated:${probeId}:${randomUUID()}`,
                tx,
                actorId,
            );
            return rotated;
        });

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(probe, secret);
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
        const { probe, secretId } = await this.matchProbeSecret(secret);
        const cameOnline = probe.status !== ProbeStatus.ONLINE;

        // Best-effort: record which credential is in use, so an operator can
        // see a probe still calling in with a rotated-away secret. Never blocks
        // the beat.
        void this.prisma.probeSecret
            .update({
                where: { id: secretId },
                data: { lastUsedAt: new Date() },
            })
            .catch(() => undefined);

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

        const supportedMonitors = monitors.filter(
            (monitor) => monitor.type === 'HTTP' || monitor.type === 'TCP',
        );

        await this.writeExecution({
            probeId: probe.id,
            target: 'heartbeat',
            trigger: ExecutionTrigger.CALLBACK,
            status: ExecutionStatus.SUCCESS,
            success: true,
            requestMeta: {},
            responseMeta: {
                monitorCount: supportedMonitors.length,
            },
        });

        return {
            probe: {
                id: updated.id,
                name: updated.name,
                status: updated.status,
                lastHeartbeat: updated.lastHeartbeat,
            },
            // Legacy agents only understand these two protocols.
            monitors: supportedMonitors.map((monitor) => ({
                id: monitor.id,
                name: monitor.name,
                type: monitor.type,
                target: monitor.target,
                interval: monitor.interval,
                timeout: monitor.timeout,
                expectedStatus: monitor.expectedStatus,
                configRevision: monitor.configRevision,
            })),
            serverTime: toIsoString(Date.now()),
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
        const existing = await this.prisma.probeResult.findMany({
            where: {
                probeId: probe.id,
                reportId: {
                    in: results.flatMap((r) =>
                        r.reportId ? [r.reportId] : [],
                    ),
                },
            },
        });
        const repeated: typeof existing = [];
        const fresh = results.filter((result) => {
            const row = existing.find((r) => r.reportId === result.reportId);
            if (!row) return true;
            const canonical = {
                monitorId: result.monitorId ?? row.monitorId,
                configRevision: result.configRevision ?? row.configRevision,
                target: result.target,
                success: result.success,
                latency: result.latency,
                statusCode: result.statusCode ?? null,
                error: result.error ?? null,
                checkedAt: result.checkedAt
                    ? toIsoString(result.checkedAt)
                    : null,
            };
            const hash = createHash('sha256')
                .update(JSON.stringify(canonical))
                .digest('hex');
            if (hash !== row.payloadHash)
                throw new ConflictException(
                    'reportId already used for another observation',
                );
            repeated.push(row);
            return false;
        });
        const assignedIds =
            probe.scope === ProbeScope.SYSTEM
                ? await this.systemProbeScheduler.getAssignedMonitorIds(
                      probe.id,
                  )
                : null;
        const authorized = await this.prisma.monitor.findMany({
            where: {
                enabled: true,
                deletedAt: null,
                project: { deletedAt: null, organization: { deletedAt: null } },
                ...(assignedIds
                    ? { id: { in: assignedIds } }
                    : {
                          organizationId: probe.organizationId!,
                          probes: { some: { probeId: probe.id } },
                      }),
            },
        });
        const prepared = fresh.map((result) => {
            if (!result.checkedAt)
                throw new BadRequestException(
                    'Agent upgrade required: checkedAt is mandatory',
                );
            const checkedAt = new Date(result.checkedAt);
            if (
                Number.isNaN(checkedAt.getTime()) ||
                checkedAt.getTime() > receivedAt.getTime() + 60_000 ||
                checkedAt.getTime() < receivedAt.getTime() - 900_000
            ) {
                throw new BadRequestException(
                    'Observation timestamp outside accepted window',
                );
            }
            const matching = authorized.filter((m) =>
                result.monitorId
                    ? m.id === result.monitorId
                    : m.target === result.target,
            );
            if (matching.length !== 1)
                throw new ForbiddenException(
                    'Monitor is not uniquely assigned to this probe',
                );
            const monitor = matching[0];
            if (monitor.target !== result.target)
                throw new BadRequestException(
                    'Target does not match assigned monitor',
                );
            if (
                result.configRevision === undefined &&
                monitor.updatedAt > checkedAt
            ) {
                throw new BadRequestException(
                    'Agent upgrade required: configuration revision is mandatory',
                );
            }
            const configRevision =
                result.configRevision ?? monitor.configRevision;
            const canonical = {
                monitorId: monitor.id,
                configRevision,
                target: result.target,
                success: result.success,
                latency: result.latency,
                statusCode: result.statusCode ?? null,
                error: result.error ?? null,
                checkedAt: toIsoString(checkedAt),
            };
            const payloadHash = createHash('sha256')
                .update(JSON.stringify(canonical))
                .digest('hex');
            return {
                monitor,
                checkedAt,
                canonical,
                payloadHash,
                reportId: result.reportId || payloadHash,
            };
        });
        prepared.sort((a, b) => a.monitor.id.localeCompare(b.monitor.id));
        const rows = await this.prisma.$transaction(async (tx) => {
            const saved: { id: string; appliedAt: Date | null }[] = [];
            for (const item of prepared) {
                await tx.$queryRaw`SELECT id FROM monitors WHERE id = ${item.monitor.id} FOR UPDATE`;
                const duplicate = await tx.probeResult.findUnique({
                    where: {
                        probeId_reportId: {
                            probeId: probe.id,
                            reportId: item.reportId,
                        },
                    },
                });
                if (duplicate) {
                    if (duplicate.payloadHash !== item.payloadHash)
                        throw new ConflictException(
                            'reportId already used for another observation',
                        );
                    saved.push(duplicate);
                    continue;
                }
                const current = await tx.monitor.findUniqueOrThrow({
                    where: { id: item.monitor.id },
                });
                if (
                    probe.scope === ProbeScope.TENANT &&
                    !(await tx.monitorProbe.findUnique({
                        where: {
                            monitorId_probeId: {
                                monitorId: current.id,
                                probeId: probe.id,
                            },
                        },
                    }))
                )
                    throw new ForbiddenException(
                        'Monitor is no longer bound to this probe',
                    );
                if (
                    current.configRevision !== item.canonical.configRevision ||
                    !current.enabled ||
                    current.deletedAt
                ) {
                    throw new ConflictException(
                        'Monitor configuration changed; refresh heartbeat',
                    );
                }
                saved.push(
                    await tx.probeResult.create({
                        data: {
                            probeId: probe.id,
                            probeRefId: probe.id,
                            reportId: item.reportId,
                            payloadHash: item.payloadHash,
                            monitorId: item.monitor.id,
                            projectId: item.monitor.projectId,
                            organizationId: item.monitor.organizationId,
                            monitorType: item.monitor.type,
                            configRevision: item.canonical.configRevision,
                            target: item.canonical.target,
                            checkedAt: item.checkedAt,
                            receivedAt,
                            success: item.canonical.success,
                            latency: item.canonical.latency,
                            statusCode: item.canonical.statusCode,
                            error: item.canonical.error,
                        },
                    }),
                );
            }
            // Liveness and ingestion commit together so a returning probe's
            // first fresh result is eligible during apply and crash recovery.
            await tx.probe.update({
                where: { id: probe.id },
                data: { lastHeartbeat: receivedAt, status: ProbeStatus.ONLINE },
            });
            return saved;
        });
        const outcomes: AppliedOutcome[] = [];
        for (const row of [...rows, ...repeated]) {
            if (row.appliedAt) continue;
            const outcome = await this.applyStoredResult(row.id);
            if (outcome) outcomes.push(outcome);
        }
        return {
            accepted: results.length,
            applied: outcomes.length,
            outcomes,
        };
    }

    async applyPendingResults() {
        const rows = await this.prisma.probeResult.findMany({
            where: { appliedAt: null, monitorId: { not: null } },
            orderBy: { receivedAt: 'asc' },
            take: 100,
        });
        for (const row of rows) {
            try {
                await this.applyStoredResult(row.id);
            } catch (error) {
                this.logger.warn(
                    `Pending probe result ${row.id}: ${(error as Error).message}`,
                );
            }
        }
    }

    private async applyStoredResult(
        id: string,
    ): Promise<AppliedOutcome | null> {
        const row = await this.prisma.probeResult.findUniqueOrThrow({
            where: { id },
        });
        if (row.appliedAt || !row.monitorId) return null;
        const monitor = await this.prisma.monitor.findUnique({
            where: { id: row.monitorId },
        });
        if (
            !monitor ||
            monitor.deletedAt ||
            !monitor.enabled ||
            monitor.configRevision !== row.configRevision ||
            Date.now() - row.checkedAt.getTime() > 900_000
        ) {
            await this.prisma.probeResult.update({
                where: { id },
                data: { appliedAt: new Date() },
            });
            return null;
        }
        const result = await this.checkerService.ingestProbeReportForMonitor(
            row.monitorId,
            {
                target: row.target,
                success: row.success,
                latency: row.latency,
                error: row.error,
                statusCode: row.statusCode,
                checkedAt: row.checkedAt,
                configRevision: row.configRevision ?? undefined,
                observationId: `probe:${row.probeId}:${row.reportId}`,
                probeResultId: id,
            },
        );
        await this.prisma.probeResult.update({
            where: { id },
            data: { appliedAt: new Date() },
        });
        return result
            ? {
                  target: row.target,
                  monitorId: result.monitorId,
                  status: result.status,
                  changed: result.changed,
              }
            : null;
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

    /** The stored form of a fresh secret — hash, plus a display prefix. */
    private secretRecord(secret: string) {
        return {
            secretHash: hashSecret(secret),
            secretPrefix: secretPrefixOf(secret),
        };
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

    /**
     * Revokes the presented credential. When it was the probe's last usable
     * secret the probe is taken offline so it stops looking healthy.
     */
    async revokeBySecret(secret: string | undefined, actorId?: string) {
        if (!secret || secret.trim() === '') {
            throw new UnauthorizedException('Missing probe secret');
        }

        const record = await this.prisma.probeSecret.findUnique({
            where: { secretHash: hashSecret(secret.trim()) },
            include: { probe: true },
        });
        if (!record || record.revokedAt) {
            throw new UnauthorizedException('Unknown probe secret');
        }

        await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM probes WHERE id = ${record.probeId} FOR UPDATE`;
            await tx.probeSecret.update({
                where: { id: record.id, revokedAt: null },
                data: { revokedAt: new Date() },
            });
            const remaining = await tx.probeSecret.count({
                where: {
                    probeId: record.probeId,
                    revokedAt: null,
                    OR: [
                        { expiresAt: null },
                        { expiresAt: { gt: new Date() } },
                    ],
                },
            });
            if (remaining === 0) {
                await tx.probe.update({
                    where: { id: record.probeId },
                    data: { status: ProbeStatus.OFFLINE },
                });
            }
            if (record.probe.organizationId) {
                await this.credentialNotice(
                    record.probe.organizationId,
                    record.probeId,
                    NotificationType.PROBE_CREDENTIAL_REVOKED,
                    'A probe credential was revoked',
                    `probe-credential-revoked:${record.id}`,
                    tx,
                    actorId,
                );
            }
        });

        return {
            ok: true,
            probeId: record.probeId,
            revokedSecretId: record.id,
        };
    }

    private async credentialNotice(
        orgId: string,
        probeId: string,
        type: NotificationType,
        title: string,
        eventKey: string,
        tx: Prisma.TransactionClient,
        actorId?: string,
    ): Promise<void> {
        await this.notifications.publish(
            {
                eventKey,
                type,
                title,
                organizationId: orgId,
                resourceType: 'Probe',
                accessScope: 'ORGANIZATION',
                resourceId: probeId,
                actorId,
                includeActor: true,
                email: true,
                recipients: [
                    ...(actorId ? [actorId] : []),
                    ...(await this.notifications.organizationRecipients(
                        orgId,
                        tx,
                        ADMIN_ROLES,
                    )),
                ],
            },
            tx,
        );
    }

    /**
     * Resolves a probe from its shared secret.
     *
     * Secrets are stored as sha256 hashes, so the lookup itself authenticates:
     * an unknown secret simply finds no row. A rotated-away secret is rejected
     * once its grace deadline passes; a revoked one is rejected immediately.
     */
    private async requireProbeBySecret(secret: string | undefined) {
        const matched = await this.matchProbeSecret(secret);
        return matched.probe;
    }

    /** Like {@link requireProbeBySecret} but also returns the credential id. */
    private async matchProbeSecret(secret: string | undefined) {
        if (!secret || secret.trim() === '') {
            throw new UnauthorizedException('Missing probe secret');
        }

        const record = await this.prisma.probeSecret.findUnique({
            where: { secretHash: hashSecret(secret.trim()) },
            include: { probe: true },
        });

        if (!record || record.revokedAt) {
            throw new UnauthorizedException('Unknown probe secret');
        }

        if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) {
            throw new UnauthorizedException('Probe secret has expired');
        }

        if (!record.probe.enabled) {
            throw new UnauthorizedException('Probe is disabled');
        }

        return { probe: record.probe, secretId: record.id };
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

    private toEntity(
        probe: {
            id: string;
            organizationId: string | null;
            scope: string;
            name: string;
            provider: string;
            region: string;
            callbackUrl: string;
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
        },
        secretPlaintext?: string,
    ): ProbeEntity {
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
            // Only present on the create/rotate response — never listed again.
            ...(secretPlaintext ? { secret: secretPlaintext } : {}),
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
