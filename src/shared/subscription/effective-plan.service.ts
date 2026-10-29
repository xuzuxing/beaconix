import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { SubscriptionStatus } from '../../generated/prisma/enums';
import type { PlanModel } from '../../generated/prisma/models';
import type { Prisma } from '../../generated/prisma/client';
import { MonitorCapacityService } from './monitor-capacity.service';

export interface SubscriptionStackEntry {
    id: string;
    plan: PlanModel;
    startsAt: Date;
    expiresAt: Date;
    status: SubscriptionStatus;
    /** Remaining days frozen on a PAUSED entry; null once restored. */
    pausedRemainingDays: number | null;
    isEffective: boolean;
}

export interface SubscriptionStack {
    effectivePlan: PlanModel | null;
    stack: SubscriptionStackEntry[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class EffectivePlanService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly capacity: MonitorCapacityService,
    ) {}

    /**
     * The effective plan is the highest-priority ACTIVE, unexpired
     * subscription. When none is valid the FREE plan is the fallback.
     *
     * Reads also restore a PAUSED subscription whose covering plan has lapsed,
     * so a tenant that upgraded for a month gets its frozen days back without
     * waiting for the hourly sweep.
     */
    async getEffectivePlan(organizationId: string): Promise<PlanModel | null> {
        return this.prisma.$transaction(async (tx) => {
            // Serialize restores with payment callbacks and the expiry sweep.
            await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId} FOR UPDATE`;
            return this.getEffectivePlanInTransaction(organizationId, tx);
        });
    }

    async getEffectivePlanInTransaction(
        organizationId: string,
        tx: Prisma.TransactionClient,
    ): Promise<PlanModel | null> {
        const now = new Date();
        const resumedSubscriptionId = await this.restorePausedSubscription(
            tx,
            organizationId,
            now,
        );

        const subscription = await tx.subscription.findFirst({
            where: {
                organizationId,
                status: SubscriptionStatus.ACTIVE,
                startsAt: { lte: now },
                expiresAt: { gt: now },
            },
            include: { plan: true },
            orderBy: { plan: { sortOrder: 'desc' } },
        });

        const plan =
            subscription?.plan ??
            (await tx.plan.findUnique({ where: { code: 'FREE' } }));
        if (plan)
            await this.capacity.reconcile(tx, organizationId, plan, now, {
                resumedSubscriptionId,
            });
        return plan;
    }

    async getSubscriptionStack(
        organizationId: string,
    ): Promise<SubscriptionStack> {
        const reconciledPlan = await this.getEffectivePlan(organizationId);
        const now = new Date();

        const [subscriptions, freePlan] = await Promise.all([
            this.prisma.subscription.findMany({
                where: {
                    organizationId,
                    status: {
                        in: [
                            SubscriptionStatus.ACTIVE,
                            SubscriptionStatus.PAUSED,
                        ],
                    },
                },
                include: { plan: true },
                orderBy: [
                    { plan: { sortOrder: 'desc' } },
                    { expiresAt: 'desc' },
                ],
            }),
            this.prisma.plan.findUnique({ where: { code: 'FREE' } }),
        ]);

        // Paused entries stay visible even once their original expiry passed —
        // their value lives in `pausedRemainingDays`, not in `expiresAt`.
        const visible = subscriptions.filter(
            (subscription) =>
                subscription.status === SubscriptionStatus.PAUSED ||
                subscription.expiresAt > now,
        );

        const active = visible.filter(
            (subscription) =>
                subscription.status === SubscriptionStatus.ACTIVE &&
                subscription.startsAt <= now,
        );
        const effectivePlan =
            reconciledPlan ?? (active.length > 0 ? active[0].plan : freePlan);

        return {
            effectivePlan,
            stack: visible.map((subscription) => ({
                id: subscription.id,
                plan: subscription.plan,
                startsAt: subscription.startsAt,
                expiresAt: subscription.expiresAt,
                status: subscription.status,
                pausedRemainingDays: subscription.pausedRemainingDays,
                isEffective:
                    subscription.status === SubscriptionStatus.ACTIVE &&
                    subscription.startsAt <= now &&
                    subscription.planId === effectivePlan?.id,
            })),
        };
    }

    // -- Helpers ---------------------------------------------------------

    /**
     * Restores at most one frozen subscription whose covering plan is gone.
     *
     * - a higher (or equal) ACTIVE plan still covers it → stay paused;
     * - the same plan already has an active subscription (e.g. a queued
     *   downgrade that just started) → add the frozen days to it and retire the
     *   paused row;
     * - otherwise resume: `expiresAt = now + pausedRemainingDays`.
     *
     * One entry per call keeps the decision unambiguous; the next read (or the
     * hourly sweep) handles the next layer.
     */
    private async restorePausedSubscription(
        tx: Prisma.TransactionClient,
        organizationId: string,
        now: Date,
    ): Promise<string | undefined> {
        const paused = await tx.subscription.findFirst({
            where: {
                organizationId,
                status: SubscriptionStatus.PAUSED,
                pausedRemainingDays: { not: null },
            },
            include: { plan: { select: { sortOrder: true } } },
            orderBy: [{ plan: { sortOrder: 'desc' } }, { pausedAt: 'desc' }],
        });

        if (!paused) return;

        const covering = await tx.subscription.findFirst({
            where: {
                organizationId,
                status: SubscriptionStatus.ACTIVE,
                startsAt: { lte: now },
                expiresAt: { gt: now },
            },
            include: { plan: { select: { sortOrder: true } } },
            orderBy: { plan: { sortOrder: 'desc' } },
        });

        if (covering && covering.plan.sortOrder >= paused.plan.sortOrder) {
            return;
        }

        const remainingDays = paused.pausedRemainingDays ?? 0;

        if (remainingDays <= 0) {
            await tx.subscription.update({
                where: { id: paused.id },
                data: {
                    status: SubscriptionStatus.EXPIRED,
                    pausedAt: null,
                    pausedRemainingDays: 0,
                },
            });
            return;
        }

        const samePlanActive = await tx.subscription.findFirst({
            where: {
                organizationId,
                planId: paused.planId,
                status: SubscriptionStatus.ACTIVE,
                expiresAt: { gt: now },
                id: { not: paused.id },
            },
            orderBy: { expiresAt: 'desc' },
        });

        if (samePlanActive) {
            await tx.subscription.update({
                where: { id: samePlanActive.id },
                data: {
                    expiresAt: new Date(
                        samePlanActive.expiresAt.getTime() +
                            remainingDays * DAY_MS,
                    ),
                },
            });
            await tx.subscription.update({
                where: { id: paused.id },
                data: {
                    status: SubscriptionStatus.EXPIRED,
                    pausedAt: null,
                    pausedRemainingDays: 0,
                },
            });
            return;
        }

        await tx.subscription.update({
            where: { id: paused.id },
            data: {
                status: SubscriptionStatus.ACTIVE,
                startsAt: now,
                expiresAt: new Date(now.getTime() + remainingDays * DAY_MS),
                pausedAt: null,
                pausedRemainingDays: null,
            },
        });
        return paused.id;
    }
}
