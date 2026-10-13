import { EffectivePlanService } from './effective-plan.service';
import type { PrismaService } from '../../infra/database/prisma.service';

const freePlan = {
    id: 'plan-free',
    code: 'FREE',
    name: '免费版',
    sortOrder: 1,
};
const proPlan = { id: 'plan-pro', code: 'PRO', name: '专业版', sortOrder: 2 };
const teamPlan = {
    id: 'plan-team',
    code: 'TEAM',
    name: '团队版',
    sortOrder: 3,
};

function createService() {
    const prisma = {
        subscription: { findFirst: jest.fn(), findMany: jest.fn() },
        plan: { findUnique: jest.fn() },
    };

    const service = new EffectivePlanService(
        prisma as unknown as PrismaService,
    );

    return { service, prisma };
}

describe('EffectivePlanService', () => {
    it('resolves active plans and FREE fallback using the explicit transaction', async () => {
        const { service, prisma } = createService();
        const tx = {
            subscription: {
                findFirst: jest.fn().mockResolvedValue({ plan: proPlan }),
            },
            plan: { findUnique: jest.fn().mockResolvedValue(freePlan) },
        };
        await expect(
            service.getEffectivePlanInTransaction('org-1', tx as never),
        ).resolves.toEqual(proPlan);
        tx.subscription.findFirst.mockResolvedValue(null);
        await expect(
            service.getEffectivePlanInTransaction('org-1', tx as never),
        ).resolves.toEqual(freePlan);
        expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
        expect(prisma.plan.findUnique).not.toHaveBeenCalled();
    });
    it('returns the highest-priority ACTIVE unexpired plan', async () => {
        const { service, prisma } = createService();
        prisma.subscription.findFirst.mockResolvedValue({
            id: 'sub-1',
            organizationId: 'org-1',
            planId: 'plan-team',
            status: 'ACTIVE',
            startsAt: new Date('2026-01-01T00:00:00.000Z'),
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
            plan: teamPlan,
        });

        const plan = await service.getEffectivePlan('org-1');

        expect(prisma.subscription.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    organizationId: 'org-1',
                    status: 'ACTIVE',
                }),
                orderBy: { plan: { sortOrder: 'desc' } },
            }),
        );
        expect(plan?.code).toBe('TEAM');
    });

    it('falls back to the FREE plan when no subscription is active', async () => {
        const { service, prisma } = createService();
        prisma.subscription.findFirst.mockResolvedValue(null);
        prisma.plan.findUnique.mockResolvedValue(freePlan);

        const plan = await service.getEffectivePlan('org-1');

        expect(plan?.code).toBe('FREE');
    });

    it('builds the subscription stack and marks the effective plan', async () => {
        const { service, prisma } = createService();
        prisma.subscription.findMany.mockResolvedValue([
            {
                id: 'sub-team',
                organizationId: 'org-1',
                planId: 'plan-team',
                status: 'ACTIVE',
                startsAt: new Date('2026-01-01T00:00:00.000Z'),
                expiresAt: new Date('2026-01-02T00:00:00.000Z'),
                plan: teamPlan,
            },
            {
                id: 'sub-pro',
                organizationId: 'org-1',
                planId: 'plan-pro',
                status: 'ACTIVE',
                startsAt: new Date('2026-01-01T00:00:00.000Z'),
                expiresAt: new Date('2099-01-01T00:00:00.000Z'),
                plan: proPlan,
            },
        ]);
        prisma.plan.findUnique.mockResolvedValue(freePlan);

        const stack = await service.getSubscriptionStack('org-1');

        expect(stack.effectivePlan?.code).toBe('PRO');
        expect(stack.stack).toHaveLength(1);
        expect(stack.stack[0].isEffective).toBe(true);
    });
});
