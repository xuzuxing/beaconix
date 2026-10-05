import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { SubscriptionStatus } from '../../generated/prisma/enums';
import type { PlanModel } from '../../generated/prisma/models';

export interface SubscriptionStackEntry {
    id: string;
    plan: PlanModel;
    expiresAt: Date;
    isEffective: boolean;
}

export interface SubscriptionStack {
    effectivePlan: PlanModel | null;
    stack: SubscriptionStackEntry[];
}

@Injectable()
export class EffectivePlanService {
    constructor(private readonly prisma: PrismaService) {}

    /**
     * The effective plan is the highest-priority ACTIVE, unexpired
     * subscription. When none is valid the FREE plan is the fallback.
     */
    async getEffectivePlan(organizationId: string): Promise<PlanModel | null> {
        const now = new Date();

        const subscription = await this.prisma.subscription.findFirst({
            where: {
                organizationId,
                status: SubscriptionStatus.ACTIVE,
                startsAt: { lte: now },
                expiresAt: { gt: now },
            },
            include: { plan: true },
            orderBy: { plan: { sortOrder: 'desc' } },
        });

        if (subscription) {
            return subscription.plan;
        }

        return this.prisma.plan.findUnique({ where: { code: 'FREE' } });
    }

    async getSubscriptionStack(
        organizationId: string,
    ): Promise<SubscriptionStack> {
        const now = new Date();

        const [subscriptions, freePlan] = await Promise.all([
            this.prisma.subscription.findMany({
                where: { organizationId, status: SubscriptionStatus.ACTIVE },
                include: { plan: true },
                orderBy: [
                    { plan: { sortOrder: 'desc' } },
                    { expiresAt: 'desc' },
                ],
            }),
            this.prisma.plan.findUnique({ where: { code: 'FREE' } }),
        ]);

        const active = subscriptions.filter(
            (subscription) => subscription.expiresAt > now,
        );
        const effectivePlan = active.length > 0 ? active[0].plan : freePlan;

        return {
            effectivePlan,
            stack: active.map((subscription) => ({
                id: subscription.id,
                plan: subscription.plan,
                expiresAt: subscription.expiresAt,
                isEffective: subscription.planId === effectivePlan?.id,
            })),
        };
    }
}
