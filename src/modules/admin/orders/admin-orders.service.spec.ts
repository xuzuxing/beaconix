import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminOrdersService } from './admin-orders.service';
import type { PrismaService } from '../../../infra/database/prisma.service';

const orderRow = {
    id: 'order-1',
    orderNo: 'BW1',
    organizationId: 'org-1',
    planId: 'plan-1',
    userId: 'user-1',
    amount: 2900,
    currency: 'CNY',
    durationDays: 30,
    cycle: 'MONTHLY',
    status: 'PENDING',
    paidAt: null,
    cancelledAt: null,
    expiresAt: new Date('2026-03-05T12:30:00.000Z'),
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
    plan: { id: 'plan-1', code: 'PRO', name: 'Pro' },
    organization: { id: 'org-1', name: 'Acme Corporation', slug: 'acme-corp' },
    user: { id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.test' },
};

function createService() {
    const prisma = {
        order: {
            findMany: jest.fn().mockResolvedValue([]),
            count: jest.fn().mockResolvedValue(0),
            findUnique: jest.fn(),
            updateMany: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
        },
        plan: { findUniqueOrThrow: jest.fn() },
        subscription: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn(),
            update: jest.fn(),
        },
        $queryRaw: jest.fn(),
        $transaction: jest.fn(),
    };
    // 手工结算在一个事务里完成；测试里让 `prisma` 同时充当 `tx`。
    prisma.$transaction.mockImplementation((callback) => callback(prisma));

    const notifications = {
        publish: jest.fn().mockResolvedValue(undefined),
        organizationRecipients: jest.fn().mockResolvedValue(['owner']),
    };

    const service = new AdminOrdersService(
        prisma as unknown as PrismaService,
        notifications as never,
        {
            getEffectivePlanInTransaction: jest.fn().mockResolvedValue(null),
        } as never,
    );

    return { service, prisma, notifications };
}

describe('AdminOrdersService', () => {
    it('lists orders across tenants with the opt-in filters applied', async () => {
        const { service, prisma } = createService();
        prisma.order.findMany.mockResolvedValue([orderRow]);
        prisma.order.count.mockResolvedValue(1);

        const result = await service.findAll({
            organizationId: 'org-1',
            status: 'PENDING',
            from: '2026-03-01T00:00:00.000Z',
            to: '2026-03-31T23:59:59.999Z',
            page: 2,
            limit: 25,
        });

        expect(prisma.order.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    organizationId: 'org-1',
                    status: 'PENDING',
                    createdAt: {
                        gte: new Date('2026-03-01T00:00:00.000Z'),
                        lte: new Date('2026-03-31T23:59:59.999Z'),
                    },
                },
                orderBy: { createdAt: 'desc' },
                take: 25,
                skip: 25,
            }),
        );
        expect(result).toMatchObject({
            total: 1,
            page: 2,
            limit: 25,
            totalPages: 1,
        });
        expect(result.items[0]).toMatchObject({
            id: 'order-1',
            organizationId: 'org-1',
            userId: 'user-1',
            cycle: 'MONTHLY',
            organization: { name: 'Acme Corporation' },
            user: { email: 'ada@example.test' },
        });
    });

    it('applies no filter when the query is empty', async () => {
        const { service, prisma } = createService();

        await service.findAll({});

        expect(prisma.order.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {},
                take: 25,
                skip: 0,
            }),
        );
    });

    it('returns one order or throws when missing', async () => {
        const { service, prisma } = createService();
        prisma.order.findUnique.mockResolvedValue(orderRow);

        await expect(service.findOne('order-1')).resolves.toMatchObject({
            id: 'order-1',
            orderNo: 'BW1',
        });

        prisma.order.findUnique.mockResolvedValue(null);
        await expect(service.findOne('missing')).rejects.toThrow(
            NotFoundException,
        );
    });

    it('cancels a pending order', async () => {
        const { service, prisma } = createService();
        prisma.order.updateMany.mockResolvedValue({ count: 1 });
        prisma.order.findUnique.mockResolvedValue({
            ...orderRow,
            status: 'CANCELLED',
            cancelledAt: new Date('2026-03-05T12:10:00.000Z'),
        });

        const cancelled = await service.cancel('order-1');

        expect(prisma.order.updateMany).toHaveBeenCalledWith({
            where: { id: 'order-1', status: 'PENDING' },
            data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
        });
        expect(cancelled.status).toBe('CANCELLED');
    });

    it('marks a pending order as paid and settles the subscription', async () => {
        const { service, prisma, notifications } = createService();
        prisma.order.findUnique
            .mockResolvedValueOnce(orderRow)
            .mockResolvedValue({
                ...orderRow,
                status: 'PAID',
                paidAt: new Date('2026-03-05T12:10:00.000Z'),
            });
        prisma.order.updateMany.mockResolvedValue({ count: 1 });
        prisma.plan.findUniqueOrThrow.mockResolvedValue({ sortOrder: 2 });
        prisma.subscription.create.mockResolvedValue({
            id: 'sub-1',
            expiresAt: new Date('2026-04-04T12:00:00.000Z'),
        });

        const paid = await service.markPaid('order-1');

        expect(prisma.order.updateMany).toHaveBeenCalledWith({
            where: { id: 'order-1', status: 'PENDING' },
            data: { status: 'PAID', paidAt: expect.any(Date) },
        });
        // 收钱必须给到权益：订阅在同一事务里被激活。
        expect(prisma.subscription.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    organizationId: 'org-1',
                    planId: 'plan-1',
                }),
            }),
        );
        expect(notifications.publish).toHaveBeenCalled();
        expect(paid.status).toBe('PAID');
    });

    it('refuses to mark an order that is no longer pending', async () => {
        const { service, prisma } = createService();
        prisma.order.findUnique.mockResolvedValue({
            ...orderRow,
            status: 'CANCELLED',
        });
        prisma.order.updateMany.mockResolvedValue({ count: 0 });

        await expect(service.markPaid('order-1')).rejects.toThrow(
            BadRequestException,
        );
        expect(prisma.subscription.create).not.toHaveBeenCalled();
    });

    it('refunds a paid order', async () => {
        const { service, prisma } = createService();
        prisma.order.updateMany.mockResolvedValue({ count: 1 });
        prisma.order.findUnique.mockResolvedValue({
            ...orderRow,
            status: 'REFUNDED',
        });

        const refunded = await service.refund('order-1');

        expect(prisma.order.updateMany).toHaveBeenCalledWith({
            where: { id: 'order-1', status: 'PAID' },
            data: { status: 'REFUNDED' },
        });
        expect(refunded.status).toBe('REFUNDED');
    });

    it('rejects a transition the order status does not allow', async () => {
        const { service, prisma } = createService();
        prisma.order.updateMany.mockResolvedValue({ count: 0 });
        prisma.order.findUnique.mockResolvedValue({ status: 'PAID' });

        await expect(service.cancel('order-1')).rejects.toThrow(
            BadRequestException,
        );
    });

    it('reports a missing order rather than a bad transition', async () => {
        const { service, prisma } = createService();
        prisma.order.updateMany.mockResolvedValue({ count: 0 });
        prisma.order.findUnique.mockResolvedValue(null);

        await expect(service.refund('missing')).rejects.toThrow(
            NotFoundException,
        );
    });
});
