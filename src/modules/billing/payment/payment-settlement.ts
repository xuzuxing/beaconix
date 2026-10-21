import { toIsoString } from '../../../common/utils/date.util';
import {
    NotificationType,
    SubscriptionStatus,
} from '../../../generated/prisma/enums';
import type { Prisma } from '../../../generated/prisma/client';
import type { OrderModel } from '../../../generated/prisma/models';
import type { NotificationsService } from '../../notifications/notifications.service';
import { ADMIN_ROLES } from '../../notifications/notification-event';

type OrderForSettlement = Pick<
    OrderModel,
    'id' | 'organizationId' | 'planId' | 'userId' | 'durationDays'
>;

export interface SettlementResult {
    id: string;
    expiresAt: Date;
    renewed: boolean;
}

/** 结算时同时算出「这笔订单买到的时段」，用于退款折算与回收。 */
interface SubscriptionActivation extends SettlementResult {
    serviceStartsAt: Date;
    serviceEndsAt: Date;
}

/**
 * 支付成功后的业务结算（与通道无关）。
 *
 * 两条完全不同的收款路径都要落到同一套规则上：微信支付 V3 的 JSAPI 回调、
 * 小程序虚拟支付的发货推送 / 兜底查单。调用方负责「这笔钱确实到账了」的
 * 判断（验签、金额核对、幂等），这里只负责「钱到账之后业务怎么办」：
 *
 * 1. 订单置为 PAID；
 * 2. 串行化同一租户的订阅变更（`FOR UPDATE`），避免并发回调把订阅堆叠算乱；
 * 3. 按订阅栈规则激活 / 续费 / 压栈（见 `activateSubscription`）；
 * 4. 发布「支付成功」与「订阅激活 / 续费」两条通知。
 *
 * 写成自由函数而不是 provider，是因为它必须在**调用方的事务**里执行，且被
 * 两个 service 共用；注入会让两边都多一层只为转发而存在的依赖。
 */
export async function settlePaidOrder(
    tx: Prisma.TransactionClient,
    params: {
        order: OrderForSettlement;
        paymentId: string;
        notifications: NotificationsService;
    },
): Promise<SettlementResult> {
    const { order, paymentId, notifications } = params;
    const now = new Date();

    await tx.order.update({
        where: { id: order.id },
        data: { status: 'PAID', paidAt: now },
    });

    // Serialize renewals and expiry sweeps for this tenant.
    await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${order.organizationId} FOR UPDATE`;

    const activation = await activateSubscription(tx, order);

    // 服务期快照：续费订单不会写 `Subscription.orderId`，退款时只能靠这两个
    // 字段判断「这笔钱买到了哪段时间」。必须与订阅变更在同一个事务里落库。
    await tx.order.update({
        where: { id: order.id },
        data: {
            serviceStartsAt: activation.serviceStartsAt,
            serviceEndsAt: activation.serviceEndsAt,
        },
    });

    const recipients = [
        order.userId,
        ...(await notifications.organizationRecipients(
            order.organizationId,
            tx,
            ADMIN_ROLES,
        )),
    ];

    await notifications.publish(
        {
            eventKey: `payment-succeeded:${paymentId}`,
            type: NotificationType.PAYMENT_SUCCEEDED,
            accessScope: 'ORGANIZATION',
            title: 'Payment received',
            body: 'Your subscription payment has been confirmed.',
            organizationId: order.organizationId,
            recipients,
            includeActor: true,
            email: true,
            resourceType: 'Order',
            resourceId: order.id,
        },
        tx,
    );

    await notifications.publish(
        {
            eventKey: `subscription-${activation.renewed ? 'renewed' : 'activated'}:${order.id}`,
            type: activation.renewed
                ? NotificationType.SUBSCRIPTION_RENEWED
                : NotificationType.SUBSCRIPTION_ACTIVATED,
            accessScope: 'ORGANIZATION',
            title: activation.renewed
                ? 'Subscription renewed'
                : 'Subscription activated',
            body: `The subscription is valid until ${toIsoString(activation.expiresAt)}.`,
            organizationId: order.organizationId,
            recipients,
            includeActor: true,
            email: true,
            resourceType: 'Subscription',
            resourceId: activation.id,
            meta: {
                expiresAt: toIsoString(activation.expiresAt),
                planId: order.planId,
            },
        },
        tx,
    );

    return activation;
}

/**
 * Applies a paid order to the subscription stack:
 *
 * - same plan, still valid → extend it (renewal);
 * - higher plan → freeze every lower active subscription (remaining days are
 *   kept and restored once the higher plan lapses), new plan starts now;
 * - same or lower plan while one is active → queue behind it
 *   (`startsAt` = current expiry), which `EffectivePlanService` already
 *   honours through its `startsAt <= now` filter.
 */
async function activateSubscription(
    tx: Prisma.TransactionClient,
    order: OrderForSettlement,
): Promise<SubscriptionActivation> {
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;

    const existing = await tx.subscription.findFirst({
        where: {
            organizationId: order.organizationId,
            planId: order.planId,
            status: SubscriptionStatus.ACTIVE,
            expiresAt: { gt: now },
        },
    });

    if (existing) {
        const startsAt = existing.expiresAt;
        const expiresAt = new Date(
            existing.expiresAt.getTime() + order.durationDays * dayMs,
        );
        await tx.subscription.update({
            where: { id: existing.id },
            data: { expiresAt },
        });
        return {
            id: existing.id,
            expiresAt,
            renewed: true,
            // 续费的时段是「原到期时刻 → 延长后的到期时刻」。
            serviceStartsAt: startsAt,
            serviceEndsAt: expiresAt,
        };
    }

    const [plan, effective] = await Promise.all([
        tx.plan.findUniqueOrThrow({
            where: { id: order.planId },
            select: { sortOrder: true },
        }),
        tx.subscription.findFirst({
            where: {
                organizationId: order.organizationId,
                status: SubscriptionStatus.ACTIVE,
                startsAt: { lte: now },
                expiresAt: { gt: now },
            },
            include: { plan: { select: { sortOrder: true } } },
            orderBy: { plan: { sortOrder: 'desc' } },
        }),
    ]);

    let startsAt = now;

    if (effective) {
        if (plan.sortOrder > effective.plan.sortOrder) {
            await pauseLowerSubscriptions(
                tx,
                order.organizationId,
                plan.sortOrder,
                now,
            );
        } else {
            // Same or lower tier: take effect when the current one lapses.
            startsAt = effective.expiresAt;
        }
    }

    const expiresAt = new Date(startsAt.getTime() + order.durationDays * dayMs);
    const subscription = await tx.subscription.create({
        data: {
            organizationId: order.organizationId,
            planId: order.planId,
            status: SubscriptionStatus.ACTIVE,
            startsAt,
            expiresAt,
            orderId: order.id,
        },
    });
    return {
        id: subscription.id,
        expiresAt,
        renewed: false,
        serviceStartsAt: startsAt,
        serviceEndsAt: expiresAt,
    };
}

/**
 * Freezes the remaining days of every active subscription below
 * `sortOrder`. At least one day is kept so a nearly-expired plan never
 * loses its last slice to rounding.
 */
async function pauseLowerSubscriptions(
    tx: Prisma.TransactionClient,
    organizationId: string,
    sortOrder: number,
    now: Date,
): Promise<void> {
    const dayMs = 24 * 60 * 60 * 1000;
    const lower = await tx.subscription.findMany({
        where: {
            organizationId,
            status: SubscriptionStatus.ACTIVE,
            startsAt: { lte: now },
            expiresAt: { gt: now },
            plan: { sortOrder: { lt: sortOrder } },
        },
        select: { id: true, expiresAt: true },
    });

    for (const subscription of lower) {
        const pausedRemainingDays = Math.max(
            1,
            Math.ceil(
                (subscription.expiresAt.getTime() - now.getTime()) / dayMs,
            ),
        );

        await tx.subscription.update({
            where: { id: subscription.id },
            data: {
                status: SubscriptionStatus.PAUSED,
                pausedAt: now,
                pausedRemainingDays,
            },
        });
    }
}
