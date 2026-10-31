import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type {
    OrderModel,
    SubscriptionModel,
    SubscriptionEntitlementModel,
} from '../../generated/prisma/models';

const DAY_MS = 86_400_000;

export function entitlementReviewRequired(): BadRequestException {
    return new BadRequestException({
        code: 'REFUND_ENTITLEMENT_REVIEW_REQUIRED',
        message:
            'Order service history requires manual reconciliation before refunding.',
    });
}

/** Caller holds the organization lock. Only provably continuous legacy stacks qualify. */
export async function trackSubscriptionEntitlements(
    tx: Prisma.TransactionClient,
    subscription: SubscriptionModel,
): Promise<boolean> {
    if (subscription.entitlementsTracked) return true;
    if (!subscription.orderId) return false;
    if (
        await tx.subscriptionEntitlement.count({
            where: { subscriptionId: subscription.id },
        })
    )
        return false;
    const orders = await tx.order.findMany({
        where: {
            organizationId: subscription.organizationId,
            planId: subscription.planId,
            status: 'PAID',
            serviceStartsAt: { gte: subscription.startsAt },
            serviceEndsAt: { lte: subscription.expiresAt },
        },
        include: { subscription: { select: { id: true } } },
        orderBy: [{ serviceStartsAt: 'asc' }, { id: 'asc' }],
    });
    // A prior restore/merge, missing snapshots, refunded root, overlapping stack,
    // or an unowned interval cannot be reconstructed from financial dates alone.
    if (!orders.length || orders[0].id !== subscription.orderId) return false;
    let cursor = +subscription.startsAt;
    for (const order of orders) {
        if (
            !order.serviceStartsAt ||
            !order.serviceEndsAt ||
            +order.serviceStartsAt !== cursor ||
            +order.serviceEndsAt <= cursor ||
            +order.serviceEndsAt - cursor !== order.durationDays * DAY_MS ||
            (order.subscription && order.subscription.id !== subscription.id)
        )
            return false;
        cursor = +order.serviceEndsAt;
    }
    if (cursor !== +subscription.expiresAt) return false;
    for (const order of orders) {
        await tx.subscriptionEntitlement.create({
            data: {
                orderId: order.id,
                subscriptionId: subscription.id,
                startsAt: order.serviceStartsAt!,
                endsAt: order.serviceEndsAt!,
            },
        });
    }
    await tx.subscription.update({
        where: { id: subscription.id },
        data: { entitlementsTracked: true },
    });
    return true;
}

/** Resolve the exact carrier; never select an arbitrary latest same-plan subscription. */
export async function orderEntitlement(
    tx: Prisma.TransactionClient,
    order: OrderModel,
) {
    let entry = await tx.subscriptionEntitlement.findUnique({
        where: { orderId: order.id },
        include: { subscription: true },
    });
    if (!entry) {
        const candidates = await tx.subscription.findMany({
            where: {
                organizationId: order.organizationId,
                planId: order.planId,
                status: { in: ['ACTIVE', 'PAUSED', 'EXPIRED'] },
                OR: [
                    { orderId: order.id },
                    ...(order.serviceStartsAt && order.serviceEndsAt
                        ? [
                              {
                                  startsAt: { lte: order.serviceStartsAt },
                                  expiresAt: { gte: order.serviceEndsAt },
                              },
                          ]
                        : []),
                ],
            },
        });
        if (
            candidates.length === 1 &&
            (await trackSubscriptionEntitlements(tx, candidates[0]))
        ) {
            entry = await tx.subscriptionEntitlement.findUnique({
                where: { orderId: order.id },
                include: { subscription: true },
            });
        }
    }
    if (!entry) return null;
    if (!entry.subscription.entitlementsTracked) return null;
    if (
        entry.subscription.organizationId !== order.organizationId ||
        entry.subscription.planId !== order.planId
    )
        throw entitlementReviewRequired();
    return entry;
}

/** Current service usage is frozen at pausedAt while a higher plan covers it. */
export function entitlementUsage(
    entry: SubscriptionEntitlementModel,
    subscription: Pick<SubscriptionModel, 'status' | 'pausedAt'>,
    now: Date,
) {
    const clock =
        subscription.status === 'PAUSED' ? subscription.pausedAt : now;
    if (!clock) throw entitlementReviewRequired();
    const elapsed = Math.max(
        0,
        Math.min(+clock, +entry.endsAt) - +entry.startsAt,
    );
    return {
        consumedMs: Number(entry.consumedMs) + elapsed,
        remainingMs: Math.max(0, +entry.endsAt - +entry.startsAt - elapsed),
        notStarted: entry.consumedMs === 0n && +clock < +entry.startsAt,
    };
}

/** Persist usage before changing schedules; moving an interval must not reset consumption. */
export async function checkpointEntitlements(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    clock: Date,
) {
    const rows = await tx.subscriptionEntitlement.findMany({
        where: { subscriptionId },
        orderBy: [{ startsAt: 'asc' }, { orderId: 'asc' }],
    });
    for (const row of rows) {
        const elapsed = Math.max(
            0,
            Math.min(+clock, +row.endsAt) - +row.startsAt,
        );
        if (elapsed > 0) {
            row.consumedMs += BigInt(elapsed);
            row.startsAt = new Date(+row.startsAt + elapsed);
            await tx.subscriptionEntitlement.update({
                where: { orderId: row.orderId },
                data: {
                    consumedMs: row.consumedMs,
                    startsAt: row.startsAt,
                },
            });
        }
    }
    return rows;
}

/** Append frozen remaining intervals after the target's tail (or resume at now). */
export async function resumeEntitlements(
    tx: Prisma.TransactionClient,
    source: SubscriptionModel,
    destinationId: string,
    startsAt: Date,
): Promise<Date | null> {
    if (!source.entitlementsTracked) return null;
    if (!source.pausedAt) throw entitlementReviewRequired();
    const rows = await checkpointEntitlements(tx, source.id, source.pausedAt);
    let cursor = +startsAt;
    for (const row of rows) {
        const remaining = +row.endsAt - +row.startsAt;
        await tx.subscriptionEntitlement.update({
            where: { orderId: row.orderId },
            data: {
                subscriptionId: destinationId,
                startsAt: new Date(cursor),
                endsAt: new Date(cursor + remaining),
            },
        });
        cursor += remaining;
    }
    return new Date(cursor);
}

/** Remove only this order's unused service and close the hole in its successors. */
export async function reclaimOrderEntitlement(
    tx: Prisma.TransactionClient,
    order: OrderModel,
    now: Date,
) {
    const entry = await orderEntitlement(tx, order);
    if (!entry) throw entitlementReviewRequired();
    const subscription = entry.subscription;
    const clock =
        subscription.status === 'PAUSED' ? subscription.pausedAt : now;
    if (!clock) throw entitlementReviewRequired();
    const rows = await checkpointEntitlements(tx, subscription.id, clock);
    const own = rows.find((row) => row.orderId === order.id)!;
    const removed = +own.endsAt - +own.startsAt;
    await tx.subscriptionEntitlement.update({
        where: { orderId: order.id },
        data: { endsAt: own.startsAt },
    });
    if (removed === 0) return;
    for (const row of rows) {
        if (row.orderId !== order.id && +row.startsAt >= +own.endsAt) {
            await tx.subscriptionEntitlement.update({
                where: { orderId: row.orderId },
                data: {
                    startsAt: new Date(+row.startsAt - removed),
                    endsAt: new Date(+row.endsAt - removed),
                },
            });
        }
    }
    const expiresAt = new Date(
        Math.max(+clock, +subscription.expiresAt - removed),
    );
    const remainingMs = Math.max(
        0,
        +expiresAt - Math.max(+clock, +subscription.startsAt),
    );
    await tx.subscription.update({
        where: { id: subscription.id },
        data: {
            expiresAt,
            ...(subscription.status === 'PAUSED'
                ? {
                      pausedRemainingDays: Math.ceil(remainingMs / DAY_MS),
                      ...(remainingMs === 0
                          ? { status: 'EXPIRED', pausedAt: null }
                          : {}),
                  }
                : {
                      status:
                          remainingMs > 0
                              ? 'ACTIVE'
                              : +subscription.startsAt > +now
                                ? 'CANCELLED'
                                : 'EXPIRED',
                  }),
        },
    });
}
