import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrderService } from './order.service';
import type { PrismaService } from '../../../infra/database/prisma.service';

const proPlan = {
    id: 'plan-pro',
    code: 'PRO',
    name: '专业版',
    price: 2900,
    durationDays: 30,
    enabled: true,
};

const freePlan = {
    id: 'plan-free',
    code: 'FREE',
    name: '免费版',
    price: 0,
    durationDays: 36500,
    enabled: true,
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
    it('creates a PENDING order with a snapshot amount', async () => {
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

        expect(order.status).toBe('PENDING');
        expect(order.amount).toBe(2900);
        expect(order.orderNo).toMatch(/^BW/);
    });

    it('rejects ordering the FREE plan', async () => {
        const { service, prisma } = createService();
        prisma.plan.findUnique.mockResolvedValue(freePlan);

        await expect(
            service.create('org-1', 'user-1', { planId: 'plan-free' }),
        ).rejects.toThrow(BadRequestException);
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
