import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrderService } from './order.service';
import type { PrismaService } from '../../../infra/database/prisma.service';

const proTerms = [
    {
        id: 'term-pro-monthly',
        planId: 'plan-pro',
        cycle: 'MONTHLY',
        durationDays: 30,
        price: 2900,
        enabled: true,
        sortOrder: 1,
    },
    {
        id: 'term-pro-yearly',
        planId: 'plan-pro',
        cycle: 'YEARLY',
        durationDays: 365,
        price: 29000,
        enabled: true,
        sortOrder: 3,
    },
];

const proPlan = {
    id: 'plan-pro',
    code: 'PRO',
    name: '专业版',
    price: 2900,
    durationDays: 30,
    enabled: true,
    terms: proTerms,
};

const freePlan = {
    id: 'plan-free',
    code: 'FREE',
    name: '免费版',
    price: 0,
    durationDays: 36500,
    enabled: true,
    terms: [
        {
            id: 'term-free-yearly',
            planId: 'plan-free',
            cycle: 'YEARLY',
            durationDays: 36500,
            price: 0,
            enabled: true,
            sortOrder: 0,
        },
    ],
};

function createService() {
    const prisma = {
        plan: { findUnique: jest.fn() },
        order: {
            create: jest.fn(),
            findMany: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        membership: { findUnique: jest.fn() },
    };

    const service = new OrderService(prisma as unknown as PrismaService);

    return { service, prisma };
}

describe('OrderService', () => {
    it('prices a new order from the cheapest enabled cycle', async () => {
        const { service, prisma } = createService();
        prisma.plan.findUnique.mockResolvedValue(proPlan);
        prisma.order.create.mockImplementation(({ data }) =>
            Promise.resolve({
                id: 'order-1',
                ...data,
                createdAt: new Date(),
                updatedAt: new Date(),
                plan: proPlan,
            }),
        );

        const order = await service.create('org-1', 'user-1', {
            planId: 'plan-pro',
        });

        expect(prisma.plan.findUnique).toHaveBeenCalledWith({
            where: { id: 'plan-pro' },
            include: {
                terms: {
                    where: { enabled: true },
                    orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }],
                },
            },
        });
        expect(prisma.order.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    amount: 2900,
                    durationDays: 30,
                    cycle: 'MONTHLY',
                    termId: 'term-pro-monthly',
                }),
            }),
        );
        expect(order.status).toBe('PENDING');
        expect(order.amount).toBe(2900);
        expect(order.orderNo).toMatch(/^BW/);
    });

    it('buys the requested cycle at that cycle price', async () => {
        const { service, prisma } = createService();
        prisma.plan.findUnique.mockResolvedValue(proPlan);
        prisma.order.create.mockImplementation(({ data }) =>
            Promise.resolve({
                id: 'order-1',
                ...data,
                createdAt: new Date(),
                updatedAt: new Date(),
                plan: proPlan,
            }),
        );

        const order = await service.create('org-1', 'user-1', {
            planId: 'plan-pro',
            cycle: 'YEARLY',
        });

        expect(order.amount).toBe(29000);
        expect(order.durationDays).toBe(365);
        expect(order.cycle).toBe('YEARLY');
    });

    it('rejects a cycle the plan does not sell', async () => {
        const { service, prisma } = createService();
        prisma.plan.findUnique.mockResolvedValue(proPlan);

        await expect(
            service.create('org-1', 'user-1', {
                planId: 'plan-pro',
                cycle: 'QUARTERLY',
            }),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('rejects ordering the FREE plan', async () => {
        const { service, prisma } = createService();
        prisma.plan.findUnique.mockResolvedValue(freePlan);

        await expect(
            service.create('org-1', 'user-1', { planId: 'plan-free' }),
        ).rejects.toThrow(BadRequestException);
    });

    it('rejects ordering a disabled plan', async () => {
        const { service, prisma } = createService();
        prisma.plan.findUnique.mockResolvedValue({
            ...proPlan,
            enabled: false,
        });

        await expect(
            service.create('org-1', 'user-1', { planId: 'plan-pro' }),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('rejects a plan that has no enabled cycle left', async () => {
        const { service, prisma } = createService();
        prisma.plan.findUnique.mockResolvedValue({ ...proPlan, terms: [] });

        await expect(
            service.create('org-1', 'user-1', { planId: 'plan-pro' }),
        ).rejects.toThrow(BadRequestException);
    });

    it('returns 404 for an unknown plan', async () => {
        const { service, prisma } = createService();
        prisma.plan.findUnique.mockResolvedValue(null);

        await expect(
            service.create('org-1', 'user-1', { planId: 'plan-missing' }),
        ).rejects.toThrow(NotFoundException);
    });

    it('returns an order only when the user is a member of its organization', async () => {
        const { service, prisma } = createService();
        prisma.order.findUnique.mockResolvedValue({
            id: 'order-1',
            organizationId: 'org-1',
            plan: proPlan,
        });
        prisma.membership.findUnique.mockResolvedValue({ id: 'member-1' });

        await expect(
            service.findOne('order-1', 'user-1'),
        ).resolves.toMatchObject({ id: 'order-1' });

        prisma.membership.findUnique.mockResolvedValue(null);
        await expect(service.findOne('order-1', 'user-1')).rejects.toThrow(
            NotFoundException,
        );
    });
});
