import { ConfigService } from '@nestjs/config';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { toIsoString } from '../../../common/utils/date.util';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ScheduledJobRegistry } from '../../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../../infra/scheduler/scheduled-jobs.constants';
import {
    NotificationType,
    SubscriptionStatus,
} from '../../../generated/prisma/enums';
import { NotificationsService } from '../../notifications/notifications.service';
import { ADMIN_ROLES } from '../../notifications/notification-event';
import { EffectivePlanService } from '../../../shared/subscription/effective-plan.service';

@Injectable()
export class SubscriptionExpiryService implements OnModuleInit {
    private readonly logger = new Logger(SubscriptionExpiryService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly registry: ScheduledJobRegistry,
        private readonly notifications: NotificationsService,
        private readonly plans: EffectivePlanService,
        private readonly config: ConfigService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.subscriptionExpirySweep,
            pattern:
                SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.subscriptionExpirySweep],
            handler: () => this.expireSubscriptions(),
        });
        this.registry.register({
            name: SCHEDULED_JOBS.monitorCapacitySweep,
            pattern:
                SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.monitorCapacitySweep],
            handler: () => this.reconcileCapacity(),
        });
    }

    async reconcileCapacity(): Promise<void> {
        const organizations = await this.prisma.organization.findMany({
            where: {
                deletedAt: null,
                OR: [
                    {
                        monitorCapacityCycles: {
                            some: { status: { in: ['GRACE', 'LIMITED'] } },
                        },
                    },
                    {
                        subscriptions: {
                            some: {
                                status: { in: ['ACTIVE', 'EXPIRED'] },
                                expiresAt: { lte: new Date() },
                            },
                        },
                    },
                ],
            },
            select: { id: true },
        });
        const failures: unknown[] = [];
        for (const { id } of organizations) {
            try {
                await this.plans.getEffectivePlan(id);
            } catch (error) {
                this.logger.error(
                    `Monitor capacity reconciliation failed for organization ${id}`,
                    error,
                );
                failures.push(error);
            }
        }
        if (failures.length)
            throw new AggregateError(
                failures,
                'Monitor capacity reconciliation failed',
            );
    }

    async expireSubscriptions(): Promise<number> {
        const now = new Date();
        const dayMs = 24 * 60 * 60 * 1000;
        const candidates = await this.prisma.subscription.findMany({
            where: {
                status: SubscriptionStatus.ACTIVE,
                expiresAt: { lte: new Date(now.getTime() + 7 * dayMs) },
                organization: { deletedAt: null },
            },
            select: { organizationId: true },
            distinct: ['organizationId'],
        });
        let expired = 0;
        for (const { organizationId } of candidates) {
            expired += await this.prisma.$transaction(async (tx) => {
                await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId} FOR UPDATE`;
                const effectivePlan =
                    await this.plans.getEffectivePlanInTransaction(
                        organizationId,
                        tx,
                    );
                const subscriptions = await tx.subscription.findMany({
                    where: {
                        organizationId,
                        status: SubscriptionStatus.ACTIVE,
                        startsAt: { lte: now },
                    },
                    include: {
                        plan: true,
                        order: { select: { userId: true } },
                    },
                    orderBy: [
                        { plan: { sortOrder: 'desc' } },
                        { expiresAt: 'desc' },
                    ],
                });
                const beforePlan = subscriptions[0]?.plan;
                const afterPlan = effectivePlan;
                const admins = await this.notifications.organizationRecipients(
                    organizationId,
                    tx,
                    ADMIN_ROLES,
                );
                let count = 0;
                for (const subscription of subscriptions) {
                    const recipients = [
                        ...(subscription.order
                            ? [subscription.order.userId]
                            : []),
                        ...admins,
                    ];
                    const expiry = toIsoString(subscription.expiresAt);
                    if (subscription.expiresAt <= now) {
                        const updated = await tx.subscription.updateMany({
                            where: {
                                id: subscription.id,
                                status: SubscriptionStatus.ACTIVE,
                                expiresAt: { lte: now },
                            },
                            data: { status: SubscriptionStatus.EXPIRED },
                        });
                        if (updated.count === 0) continue;
                        count += updated.count;
                        // Capacity reconciliation already records the relevant
                        // grace/limited email in this transaction. Do not send
                        // a second generic expiry email for the same downgrade.
                        const capacityCycle =
                            await tx.monitorCapacityCycle.findFirst({
                                where: {
                                    organizationId,
                                    sourceSubscriptionId: subscription.id,
                                },
                                orderBy: { createdAt: 'desc' },
                            });
                        if (capacityCycle) continue;
                        const effectivePlanChanged =
                            beforePlan?.id !== afterPlan?.id &&
                            subscription.planId === beforePlan?.id;
                        await this.notifications.publish(
                            {
                                eventKey: `subscription-expired:${subscription.id}:${expiry}`,
                                type: NotificationType.SUBSCRIPTION_EXPIRED,
                                accessScope: 'ORGANIZATION',
                                title: 'Subscription expired',
                                body: effectivePlanChanged
                                    ? `The ${subscription.plan.name} subscription expired. The effective plan is now ${afterPlan?.name ?? 'unavailable'}.`
                                    : `The ${subscription.plan.name} subscription expired. Your effective plan remains ${afterPlan?.name ?? 'unavailable'}.`,
                                organizationId,
                                recipients,
                                includeActor: true,
                                email: true,
                                resourceType: 'Subscription',
                                resourceId: subscription.id,
                                meta: {
                                    expiresAt: expiry,
                                    effectivePlanChanged,
                                    effectivePlanId: afterPlan?.id ?? null,
                                    previousPlanId: beforePlan?.id ?? null,
                                },
                            },
                            tx,
                        );
                        continue;
                    }
                    const remaining =
                        subscription.expiresAt.getTime() - now.getTime();
                    const days =
                        remaining <= dayMs
                            ? 1
                            : remaining <= 3 * dayMs
                              ? 3
                              : remaining <= 7 * dayMs
                                ? 7
                                : null;
                    if (days === null) continue;
                    const nextSubscription = await tx.subscription.findFirst({
                        where: {
                            organizationId,
                            OR: [
                                {
                                    status: 'ACTIVE',
                                    startsAt: { lte: subscription.expiresAt },
                                    expiresAt: { gt: subscription.expiresAt },
                                },
                                {
                                    status: 'PAUSED',
                                    pausedRemainingDays: { gt: 0 },
                                },
                            ],
                        },
                        include: { plan: true },
                        orderBy: { plan: { sortOrder: 'desc' } },
                    });
                    const nextPlan =
                        nextSubscription?.plan ??
                        (await tx.plan.findUnique({ where: { code: 'FREE' } }));
                    let impact = '';
                    if (
                        afterPlan &&
                        nextPlan &&
                        nextPlan.maxMonitors < afterPlan.maxMonitors
                    ) {
                        const configured = await tx.monitor.count({
                            where: { organizationId, deletedAt: null },
                        });
                        if (configured > nextPlan.maxMonitors) {
                            impact = ` 若届时实际降级为 ${nextPlan.name}，当前 ${configured} 个监控超出 ${nextPlan.maxMonitors} 个名额；数量超额部分在实际降级后宽限 72 小时，之后停止运行，配置和历史保留。`;
                        }
                    }
                    const actionUrl = new URL(
                        this.config.get<string>('app.webUrl') ??
                            'http://localhost:3000',
                    );
                    actionUrl.searchParams.set(
                        'organizationId',
                        organizationId,
                    );
                    await this.notifications.publish(
                        {
                            eventKey: `subscription-expiring:${subscription.id}:${expiry}:${days}`,
                            type: NotificationType.SUBSCRIPTION_EXPIRING,
                            accessScope: 'ORGANIZATION',
                            title: 'Subscription nearing expiry',
                            body: `The ${subscription.plan.name} subscription expires within ${days} day${days === 1 ? '' : 's'} (${expiry}, UTC).${impact}`,
                            actionUrl: actionUrl.toString(),
                            actionLabel: '管理监控与套餐',
                            organizationId,
                            recipients,
                            includeActor: true,
                            email: true,
                            resourceType: 'Subscription',
                            resourceId: subscription.id,
                            meta: { expiresAt: expiry, days },
                        },
                        tx,
                    );
                }
                return count;
            });
        }

        if (expired > 0) {
            this.logger.log(`Marked ${expired} subscription(s) expired`);
        }

        return expired;
    }
}
