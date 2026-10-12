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

@Injectable()
export class SubscriptionExpiryService implements OnModuleInit {
    private readonly logger = new Logger(SubscriptionExpiryService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly registry: ScheduledJobRegistry,
        private readonly notifications: NotificationsService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.subscriptionExpirySweep,
            pattern:
                SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.subscriptionExpirySweep],
            handler: () => this.expireSubscriptions(),
        });
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
                const afterPlan =
                    subscriptions.find(
                        (subscription) => subscription.expiresAt > now,
                    )?.plan ??
                    (await tx.plan.findUnique({ where: { code: 'FREE' } }));
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
                        const effectivePlanChanged =
                            beforePlan?.id !== afterPlan?.id &&
                            subscription.planId === beforePlan?.id;
                        await this.notifications.publish(
                            {
                                eventKey: `subscription-expired:${subscription.id}:${expiry}`,
                                type: NotificationType.SUBSCRIPTION_EXPIRED,
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
                    await this.notifications.publish(
                        {
                            eventKey: `subscription-expiring:${subscription.id}:${expiry}:${days}`,
                            type: NotificationType.SUBSCRIPTION_EXPIRING,
                            title: 'Subscription nearing expiry',
                            body: `The ${subscription.plan.name} subscription expires within ${days} day${days === 1 ? '' : 's'}.`,
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
