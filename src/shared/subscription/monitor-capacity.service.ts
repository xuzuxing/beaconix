import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../infra/database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type {
    MonitorCapacityCycleModel,
    PlanModel,
} from '../../generated/prisma/models';
import { NotificationType } from '../../generated/prisma/enums';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { ADMIN_ROLES } from '../../modules/notifications/notification-event';
import {
    CAPACITY_GRACE_MS,
    capacityRestricted,
    capacityStateKey,
    MONITOR_CAPACITY_REASON,
    retainedMonitorIds,
} from './monitor-capacity.util';

type Tx = Prisma.TransactionClient;
type CapacityPlan = Pick<
    PlanModel,
    'id' | 'name' | 'maxMonitors' | 'sortOrder'
>;

@Injectable()
export class MonitorCapacityService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly notifications: NotificationsService,
        private readonly config: ConfigService,
    ) {}

    /** Caller holds the organization UPDATE lock and has normalized the stack. */
    async reconcile(
        tx: Tx,
        organizationId: string,
        plan: CapacityPlan,
        now = new Date(),
        replay?: {
            source?: Awaited<
                ReturnType<MonitorCapacityService['downgradeSource']>
            >;
            silent?: boolean;
            resumedSubscriptionId?: string;
        },
    ) {
        const isReplay = !!replay && 'source' in replay;
        const org = await tx.organization.findFirst({
            where: { id: organizationId, deletedAt: null },
        });
        if (!org) throw new NotFoundException('Organization not found');
        let cycle = await tx.monitorCapacityCycle.findFirst({
            where: { organizationId, status: { in: ['GRACE', 'LIMITED'] } },
        });
        const previousLimit = org.monitorCapacityLimit;
        const changed =
            org.monitorCapacityPlanId !== plan.id ||
            previousLimit !== plan.maxMonitors;

        // The historical row supplies the real boundary even if the sweep was
        // delayed or a refund already marked the subscription EXPIRED.
        let source: Awaited<ReturnType<typeof this.downgradeSource>> =
            replay?.source ?? null;
        if (
            !isReplay &&
            changed &&
            (previousLimit === null || previousLimit > plan.maxMonitors)
        ) {
            source = await this.downgradeSource(
                tx,
                organizationId,
                plan,
                now,
                org.monitorCapacityPlanId,
                org.monitorCapacityObservedAt,
            );
        }
        if (!isReplay && (org.monitorCapacityObservedAt || source)) {
            // Replay starts as well as expiries: a queued upgrade and expiry can
            // both happen during downtime, leaving the same plan at either end.
            const since =
                org.monitorCapacityObservedAt ??
                new Date(source!.expiresAt.getTime() - 1);
            const history = await tx.subscription.findMany({
                where: {
                    organizationId,
                    status: { in: ['ACTIVE', 'EXPIRED'] },
                    startsAt: { lte: now },
                    expiresAt: { gt: since },
                },
                include: { plan: true, order: { select: { userId: true } } },
                orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
            });
            const resumed = history.find(
                (row) => row.id === replay?.resumedSubscriptionId,
            );
            if (resumed) {
                const coveringExpiry = history
                    .filter(
                        (row) =>
                            row.plan.sortOrder > resumed.plan.sortOrder &&
                            row.expiresAt <= now,
                    )
                    .sort((a, b) => +b.expiresAt - +a.expiresAt)[0]?.expiresAt;
                // Restoring frozen days keeps billing's startsAt=now. For the
                // capacity timeline it replaces the covering plan at expiry,
                // so downtime must not invent an intervening FREE downgrade.
                if (coveringExpiry) resumed.startsAt = coveringExpiry;
            }
            const boundaries = [
                ...new Set(
                    history
                        .flatMap((row) => [row.startsAt, row.expiresAt])
                        .filter((at) => at > since && at <= now)
                        .map((at) => +at),
                ),
            ].sort((a, b) => a - b);
            if (boundaries.length) {
                const fallback = await tx.plan.findUnique({
                    where: { code: 'FREE' },
                });
                let result: MonitorCapacityCycleModel | null = null;
                for (let i = 0; i < boundaries.length; i++) {
                    const boundary = boundaries[i];
                    const covering = history
                        .filter(
                            (row) =>
                                +row.startsAt <= boundary &&
                                +row.expiresAt > boundary,
                        )
                        .sort((a, b) => b.plan.sortOrder - a.plan.sortOrder)[0];
                    const expiring =
                        history
                            .filter((row) => +row.expiresAt === boundary)
                            .sort(
                                (a, b) => b.plan.sortOrder - a.plan.sortOrder,
                            )[0] ?? null;
                    const last = i === boundaries.length - 1;
                    result = await this.reconcile(
                        tx,
                        organizationId,
                        last ? plan : (covering?.plan ?? fallback ?? plan),
                        now,
                        { source: expiring, silent: !last },
                    );
                }
                return result;
            }
        }
        const fromLimit = previousLimit ?? source?.plan.maxMonitors;
        const isDowngrade =
            changed && fromLimit !== undefined && fromLimit > plan.maxMonitors;

        const monitors =
            cycle || isDowngrade
                ? await tx.monitor.findMany({
                      where: { organizationId, deletedAt: null },
                      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                      select: {
                          id: true,
                          enabled: true,
                          quotaGraceEndsAt: true,
                      },
                  })
                : [];

        if (isDowngrade && monitors.length > plan.maxMonitors) {
            const startsAt = source?.expiresAt ?? now;
            const sourceKey = createHash('sha256')
                .update(
                    [
                        organizationId,
                        org.monitorCapacityPlanId ?? source?.planId,
                        source?.id ?? 'plan-change',
                        startsAt.toISOString(),
                        plan.id,
                        plan.maxMonitors,
                    ].join(':'),
                )
                .digest('hex');
            if (cycle) {
                await tx.monitorCapacityCycle.update({
                    where: { id: cycle.id },
                    data: { status: 'RESOLVED', resolvedAt: now },
                });
            }
            const previousSelection = cycle?.selectedMonitorIds ?? [];
            cycle = await tx.monitorCapacityCycle.upsert({
                where: { sourceKey },
                update: {},
                create: {
                    organizationId,
                    sourceKey,
                    sourceSubscriptionId: source?.id,
                    purchaserId: source?.order?.userId,
                    fromPlanId: org.monitorCapacityPlanId ?? source!.planId,
                    fromLimit: fromLimit,
                    toPlanId: plan.id,
                    limit: plan.maxMonitors,
                    startsAt,
                    graceEndsAt: new Date(
                        startsAt.getTime() + CAPACITY_GRACE_MS,
                    ),
                    selectedMonitorIds: previousSelection,
                },
            });
            // A consumed historical transition must never restart a grace period.
            if (cycle.status === 'RESOLVED') cycle = null;
        }
        if (
            changed ||
            org.monitorCapacityObservedAt?.getTime() !== now.getTime()
        ) {
            await tx.organization.update({
                where: { id: organizationId },
                data: {
                    monitorCapacityPlanId: plan.id,
                    monitorCapacityLimit: plan.maxMonitors,
                    monitorCapacityObservedAt: now,
                },
            });
        }
        if (!cycle) return null;

        const keep = retainedMonitorIds(
            monitors,
            cycle.selectedMonitorIds,
            plan.maxMonitors,
        );
        const retained = new Set(keep);
        const excluded = monitors.filter(({ id }) => !retained.has(id));
        const deadlines = new Map(
            excluded.map((monitor) => [
                monitor.id,
                monitor.quotaGraceEndsAt &&
                monitor.quotaGraceEndsAt < cycle!.graceEndsAt
                    ? monitor.quotaGraceEndsAt
                    : cycle!.graceEndsAt,
            ]),
        );
        const blocked = excluded.filter(
            (monitor) => deadlines.get(monitor.id)! <= now,
        );
        const blockedIds = blocked.map(({ id }) => id);
        const oldRestricted = new Set(cycle.restrictedMonitorIds);
        const released = monitors.filter(
            (monitor) =>
                retained.has(monitor.id) &&
                (capacityRestricted(monitor, now) ||
                    oldRestricted.has(monitor.id)),
        );

        // Org-before-monitor lock ordering matches check/ingest/state writes.
        // Preserve earlier deadlines during another downgrade; they cannot be
        // extended by repeatedly buying/expiring a smaller plan.
        const markerUpdates = new Map<number | null, string[]>();
        for (const monitor of monitors) {
            const deadline = deadlines.get(monitor.id) ?? null;
            if (monitor.quotaGraceEndsAt?.getTime() !== deadline?.getTime()) {
                const key = deadline?.getTime() ?? null;
                markerUpdates.set(key, [
                    ...(markerUpdates.get(key) ?? []),
                    monitor.id,
                ]);
            }
        }
        for (const [deadline, ids] of markerUpdates) {
            await tx.monitor.updateMany({
                where: { id: { in: ids } },
                data: {
                    quotaGraceEndsAt:
                        deadline === null ? null : new Date(deadline),
                },
            });
        }
        const stopped = blocked.filter(({ enabled }) => enabled);
        if (stopped.length) {
            await tx.monitorState.updateMany({
                where: {
                    monitorId: { in: stopped.map(({ id }) => id) },
                    OR: [
                        { executionBlockedReason: null },
                        {
                            executionBlockedReason: {
                                not: MONITOR_CAPACITY_REASON,
                            },
                        },
                    ],
                },
                data: {
                    status: 'UNKNOWN',
                    executionBlockedReason: MONITOR_CAPACITY_REASON,
                    failCount: 0,
                    connectivityFailCount: 0,
                },
            });
        }
        if (released.length) {
            // A fresh observation is required after release. Fencing with a
            // revision prevents pre-restriction queued reports from reviving UP.
            await tx.monitor.updateMany({
                where: { id: { in: released.map(({ id }) => id) } },
                data: {
                    revision: { increment: 1 },
                    configRevision: { increment: 1 },
                },
            });
            await tx.monitorState.updateMany({
                where: {
                    monitorId: {
                        in: released
                            .filter(({ enabled }) => enabled)
                            .map(({ id }) => id),
                    },
                },
                data: {
                    status: 'UNKNOWN',
                    executionBlockedReason: null,
                    failCount: 0,
                    connectivityFailCount: 0,
                    lastAppliedObservationAt: null,
                    lastAppliedObservationId: null,
                    lastLocalCheckAt: null,
                },
            });
        }

        const status =
            excluded.length === 0
                ? 'RESOLVED'
                : blocked.length
                  ? 'LIMITED'
                  : 'GRACE';
        cycle = await tx.monitorCapacityCycle.update({
            where: { id: cycle.id },
            data: {
                toPlanId: plan.id,
                limit: plan.maxMonitors,
                retainedMonitorIds: keep,
                restrictedMonitorIds: blockedIds,
                status,
                ...(status === 'RESOLVED' ? { resolvedAt: now } : {}),
            },
        });
        if (replay?.silent) return cycle;
        const pending = excluded.filter(
            (monitor) => monitor.enabled && deadlines.get(monitor.id)! > now,
        ).length;
        const facts = {
            pending,
            planName: plan.name,
            total: monitors.length,
            retained: keep.length,
            stopped: stopped.length,
            manuallyPaused: monitors.filter(({ enabled }) => !enabled).length,
            deadline: cycle.graceEndsAt.toISOString(),
        };
        if (blocked.length) {
            await this.notice(
                tx,
                cycle,
                'limited:' +
                    createHash('sha256')
                        .update(blockedIds.slice().sort().join(','))
                        .digest('hex'),
                NotificationType.MONITOR_CAPACITY_LIMITED,
                '监控数量限制已生效',
                `当前套餐 ${plan.name}；配置 ${facts.total} 个，保留名额 ${facts.retained} 个，实际停止运行 ${facts.stopped} 个。${pending ? `另有 ${pending} 个监控仍在宽限期，将于 ${facts.deadline}（UTC）结束。` : ''}配置和历史保留，续费或调整保留名单可恢复。`,
                facts,
            );
        } else if (
            status === 'GRACE' &&
            !cycle.announcedAt &&
            cycle.graceEndsAt.getTime() - now.getTime() > CAPACITY_GRACE_MS / 3
        ) {
            await this.notice(
                tx,
                cycle,
                'started',
                NotificationType.MONITOR_CAPACITY_GRACE_STARTED,
                '监控数量宽限期已开始',
                `套餐已降级为 ${plan.name}，现有 ${facts.total} 个监控，可保留 ${facts.retained} 个。超额监控可继续运行至 ${facts.deadline}（UTC）。请在截止前选择保留名单或续费。`,
                facts,
            );
            cycle = await tx.monitorCapacityCycle.update({
                where: { id: cycle.id },
                data: { announcedAt: now },
            });
        }
        // A subsequent downgrade can preserve an earlier cohort's deadline.
        // The outbox key deduplicates each deadline across replicas and sweeps.
        const warningGroups = new Map<number, number>();
        for (const monitor of excluded) {
            const deadline = deadlines.get(monitor.id)!;
            if (
                monitor.enabled &&
                deadline > now &&
                +deadline - +now <= 24 * 60 * 60 * 1000
            ) {
                warningGroups.set(
                    +deadline,
                    (warningGroups.get(+deadline) ?? 0) + 1,
                );
            }
        }
        for (const [at, count] of warningGroups) {
            const deadline = new Date(at).toISOString();
            await this.notice(
                tx,
                cycle,
                `ending:${deadline}`,
                NotificationType.MONITOR_CAPACITY_GRACE_ENDING,
                '监控数量宽限期即将结束',
                `宽限将于 ${deadline}（UTC）结束。${count} 个仍在运行的监控将受数量限制，请及时选择保留名单或续费。`,
                { ...facts, deadline, pending: count },
            );
        }
        if (warningGroups.size && !cycle.warnedAt) {
            cycle = await tx.monitorCapacityCycle.update({
                where: { id: cycle.id },
                data: { warnedAt: now, announcedAt: cycle.announcedAt ?? now },
            });
        }
        if (released.length) {
            await this.notice(
                tx,
                cycle,
                'restored:' +
                    createHash('sha256')
                        .update(
                            released
                                .map(({ id }) => id)
                                .sort()
                                .join(','),
                        )
                        .digest('hex'),
                NotificationType.MONITOR_CAPACITY_RESTORED,
                '监控套餐限制已解除',
                `${released.filter(({ enabled }) => enabled).length} 个监控已解除限制，等待新的检查结果。${facts.manuallyPaused} 个手动暂停的监控保持暂停。`,
                {
                    ...facts,
                    released: released.length,
                    releasedMonitorIds: released.map(({ id }) => id),
                },
            );
        }
        return cycle;
    }

    private downgradeSource(
        tx: Tx,
        organizationId: string,
        plan: CapacityPlan,
        now: Date,
        previousPlanId: string | null,
        observedAt: Date | null,
    ) {
        return tx.subscription.findFirst({
            where: {
                organizationId,
                status: { in: ['ACTIVE', 'EXPIRED'] },
                startsAt: { lt: now },
                expiresAt: {
                    lte: now,
                    ...(observedAt ? { gt: observedAt } : {}),
                },
                ...(previousPlanId
                    ? { planId: previousPlanId }
                    : {
                          plan: {
                              maxMonitors: { gt: plan.maxMonitors },
                              sortOrder: { gt: plan.sortOrder },
                          },
                      }),
            },
            include: { plan: true, order: { select: { userId: true } } },
            orderBy: [{ expiresAt: 'desc' }, { id: 'desc' }],
        });
    }

    async view(organizationId: string, tx: Tx = this.prisma) {
        const cycle = await tx.monitorCapacityCycle.findFirst({
            where: { organizationId, status: { in: ['GRACE', 'LIMITED'] } },
        });
        return {
            cycleId: cycle?.id ?? null,
            status: cycle?.status ?? 'WITHIN_LIMIT',
            startsAt: cycle?.startsAt ?? null,
            graceEndsAt: cycle?.graceEndsAt ?? null,
            limit: cycle?.limit ?? null,
            selectedMonitorIds: cycle?.selectedMonitorIds ?? [],
            retainedMonitorIds: cycle?.retainedMonitorIds ?? [],
            restrictedMonitorIds: cycle?.restrictedMonitorIds ?? [],
            monitorDeadlines: cycle
                ? await tx.monitor.findMany({
                      where: {
                          organizationId,
                          deletedAt: null,
                          quotaGraceEndsAt: { not: null },
                      },
                      select: {
                          id: true,
                          quotaGraceEndsAt: true,
                          enabled: true,
                      },
                      orderBy: [{ quotaGraceEndsAt: 'asc' }, { id: 'asc' }],
                  })
                : [],
        };
    }

    /** Caller rechecks admin access under the same org lock before calling. */
    async select(
        tx: Tx,
        organizationId: string,
        cycleId: string,
        ids: string[],
    ) {
        const cycle = await tx.monitorCapacityCycle.findFirst({
            where: {
                id: cycleId,
                organizationId,
                status: { in: ['GRACE', 'LIMITED'] },
            },
        });
        if (!cycle)
            throw new BadRequestException(
                'The downgrade cycle has changed; refresh capacity',
            );
        if (ids.length > cycle.limit || new Set(ids).size !== ids.length)
            throw new BadRequestException(
                'Selection exceeds the plan limit or contains duplicates',
            );
        const count = await tx.monitor.count({
            where: {
                id: { in: ids },
                organizationId,
                deletedAt: null,
                project: { deletedAt: null },
            },
        });
        if (count !== ids.length)
            throw new BadRequestException(
                'Selection contains unavailable monitors',
            );
        await tx.monitorCapacityCycle.update({
            where: { id: cycle.id },
            data: { selectedMonitorIds: ids },
        });
    }

    private async notice(
        tx: Tx,
        cycle: MonitorCapacityCycleModel,
        phase: string,
        type: NotificationType,
        title: string,
        body: string,
        meta: Record<string, string | number | string[]>,
    ) {
        const recipients = [
            ...(cycle.purchaserId ? [cycle.purchaserId] : []),
            ...(await this.notifications.organizationRecipients(
                cycle.organizationId,
                tx,
                ADMIN_ROLES,
            )),
        ];
        const previousPlan = await tx.plan.findUnique({
            where: { id: cycle.fromPlanId },
            select: { name: true },
        });
        const context = `原套餐 ${previousPlan?.name ?? cycle.fromPlanId}（名额 ${cycle.fromLimit}），当前套餐 ${String(meta.planName)}。`;
        const webUrl =
            this.config.get<string>('app.webUrl') ?? 'http://localhost:3000';
        const actionUrl = new URL(webUrl);
        actionUrl.searchParams.set('organizationId', cycle.organizationId);
        await this.notifications.publish(
            {
                eventKey: `monitor-capacity:${cycle.organizationId}:${cycle.id}:${phase}`,
                type,
                title,
                body: `${context}\n${body}\n处理入口：${actionUrl.toString()}`,
                organizationId: cycle.organizationId,
                accessScope: 'ORGANIZATION',
                recipients,
                email: true,
                includeActor: true,
                actionUrl: actionUrl.toString(),
                actionLabel: '管理监控与套餐',
                resourceType: 'MonitorCapacityCycle',
                resourceId: cycle.id,
                meta: {
                    ...meta,
                    cycleId: cycle.id,
                    capacityStateKey: capacityStateKey(cycle),
                },
            },
            tx,
        );
    }
}
