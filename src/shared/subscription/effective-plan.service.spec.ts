import { EffectivePlanService } from './effective-plan.service';

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

const DAY_MS = 24 * 60 * 60 * 1000;

function createService() {
    const prisma: any = {
        $queryRaw: jest.fn(),
        subscription: {
            findFirst: jest.fn(),
            findMany: jest.fn(),
            count: jest.fn().mockResolvedValue(0),
            update: jest.fn(),
        },
        plan: { findUnique: jest.fn() },
    };
    prisma.$transaction = jest.fn((run: (tx: unknown) => unknown) =>
        run(prisma),
    );

    const service = new EffectivePlanService(prisma, {
        reconcile: jest.fn().mockResolvedValue(null),
    } as never);

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

    it('resumes a frozen subscription once the covering plan has lapsed', async () => {
        const { service, prisma } = createService();
        prisma.subscription.count.mockResolvedValue(1);
        prisma.subscription.findFirst.mockImplementation(({ where }: any) => {
            if (where.status === 'PAUSED') {
                return Promise.resolve({
                    id: 'sub-pro',
                    planId: 'plan-pro',
                    status: 'PAUSED',
                    pausedRemainingDays: 100,
                    plan: { sortOrder: 2 },
                });
            }
            return Promise.resolve(null);
        });
        prisma.plan.findUnique.mockResolvedValue(freePlan);

        await service.getEffectivePlan('org-1');

        expect(prisma.$transaction).toHaveBeenCalled();
        const resumed = prisma.subscription.update.mock.calls[0][0];
        expect(resumed.where).toEqual({ id: 'sub-pro' });
        expect(resumed.data.status).toBe('ACTIVE');
        expect(resumed.data.pausedRemainingDays).toBeNull();
        const resumedDays = Math.round(
            (resumed.data.expiresAt.getTime() - Date.now()) / DAY_MS,
        );
        expect(resumedDays).toBe(100);
    });

    it('keeps a paused plan while a higher plan still covers it', async () => {
        const { service, prisma } = createService();
        prisma.subscription.count.mockResolvedValue(1);
        prisma.subscription.findFirst.mockImplementation(({ where }: any) => {
            if (where.status === 'PAUSED') {
                return Promise.resolve({
                    id: 'sub-pro',
                    planId: 'plan-pro',
                    status: 'PAUSED',
                    pausedRemainingDays: 100,
                    plan: { sortOrder: 2 },
                });
            }
            return Promise.resolve({
                id: 'sub-team',
                status: 'ACTIVE',
                plan: { sortOrder: 3 },
                planId: 'plan-team',
            });
        });

        await service.getEffectivePlan('org-1');

        expect(prisma.subscription.update).not.toHaveBeenCalled();
    });

    it('merges the frozen days into an already-active same plan', async () => {
        const { service, prisma } = createService();
        prisma.subscription.count.mockResolvedValue(1);
        const queuedExpiry = new Date(Date.now() + 10 * DAY_MS);
        prisma.subscription.findFirst.mockImplementation(({ where }: any) => {
            if (where.status === 'PAUSED') {
                return Promise.resolve({
                    id: 'sub-pro-paused',
                    planId: 'plan-pro',
                    status: 'PAUSED',
                    pausedRemainingDays: 100,
                    plan: { sortOrder: 2 },
                });
            }
            if (where.planId === 'plan-pro') {
                return Promise.resolve({
                    id: 'sub-pro-queued',
                    expiresAt: queuedExpiry,
                });
            }
            return Promise.resolve(null);
        });
        prisma.plan.findUnique.mockResolvedValue(proPlan);

        await service.getEffectivePlan('org-1');

        expect(prisma.subscription.update).toHaveBeenCalledWith({
            where: { id: 'sub-pro-queued' },
            data: {
                expiresAt: new Date(queuedExpiry.getTime() + 100 * DAY_MS),
            },
        });
        expect(prisma.subscription.update).toHaveBeenCalledWith({
            where: { id: 'sub-pro-paused' },
            data: expect.objectContaining({ status: 'EXPIRED' }),
        });
    });

    it('builds the subscription stack and marks the effective plan', async () => {
        const { service, prisma } = createService();
        prisma.subscription.findFirst.mockImplementation(({ where }) =>
            where.status === 'ACTIVE' ? { plan: proPlan } : null,
        );
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

    it('shows frozen entries in the stack without making them effective', async () => {
        const { service, prisma } = createService();
        prisma.subscription.findFirst.mockImplementation(({ where }) =>
            where.status === 'ACTIVE' ? { plan: teamPlan } : null,
        );
        prisma.subscription.findMany.mockResolvedValue([
            {
                id: 'sub-team',
                planId: 'plan-team',
                status: 'ACTIVE',
                startsAt: new Date('2026-01-01T00:00:00.000Z'),
                expiresAt: new Date('2099-01-01T00:00:00.000Z'),
                pausedRemainingDays: null,
                plan: teamPlan,
            },
            {
                id: 'sub-pro',
                planId: 'plan-pro',
                status: 'PAUSED',
                startsAt: new Date('2026-01-01T00:00:00.000Z'),
                // The frozen expiry is already in the past; the remaining days
                // are the source of truth for a paused entry.
                expiresAt: new Date('2020-01-01T00:00:00.000Z'),
                pausedRemainingDays: 100,
                plan: proPlan,
            },
        ]);
        prisma.plan.findUnique.mockResolvedValue(freePlan);

        const stack = await service.getSubscriptionStack('org-1');

        expect(stack.effectivePlan?.code).toBe('TEAM');
        expect(stack.stack).toHaveLength(2);
        expect(stack.stack[1]).toEqual(
            expect.objectContaining({
                status: 'PAUSED',
                pausedRemainingDays: 100,
                isEffective: false,
            }),
        );
    });
});
