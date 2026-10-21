import type { PrismaService } from '../../../infra/database/prisma.service';
import type { RefundService } from '../../billing/refund/refund.service';
import { AdminRefundsService } from './admin-refunds.service';

const refundRow = {
    id: 'refund-1',
    refundNo: 'RF1',
    orderId: 'order-1',
    organizationId: 'org-1',
    channel: 'WECHAT' as const,
    type: 'PRORATED' as const,
    status: 'SUCCESS' as const,
    amount: 19933,
    settledAmount: 19933,
    policyCode: 'PRORATED',
    usedDays: 10,
    remainingDays: 20,
    reason: 'not satisfied',
    requestedBy: 'user-1',
    approvedBy: null,
    channelRefundId: 'wx-refund-1',
    failureReason: null,
    rawResponse: null,
    refundedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    order: { orderNo: 'BW1' },
};

function createService() {
    const prisma = {
        refund: {
            aggregate: jest.fn(),
            groupBy: jest.fn(),
            findMany: jest.fn(),
            findUnique: jest.fn(),
            count: jest.fn(),
        },
    };
    const refunds = {
        create: jest.fn(),
        quote: jest.fn(),
        retry: jest.fn(),
        approve: jest.fn(),
        markClosed: jest.fn(),
    };

    const service = new AdminRefundsService(
        prisma as unknown as PrismaService,
        refunds as unknown as RefundService,
    );

    return { service, prisma, refunds };
}

describe('AdminRefundsService', () => {
    describe('stats', () => {
        it('aggregates refunds by status, channel and policy', async () => {
            const { service, prisma } = createService();
            prisma.refund.aggregate.mockResolvedValue({
                _count: { _all: 3 },
                _sum: { amount: 50000, settledAmount: 40000 },
            });
            prisma.refund.groupBy
                .mockResolvedValueOnce([
                    {
                        status: 'SUCCESS',
                        _count: { _all: 2 },
                        _sum: { amount: 30000 },
                    },
                    {
                        status: 'FAILED',
                        _count: { _all: 1 },
                        _sum: { amount: 20000 },
                    },
                ])
                .mockResolvedValueOnce([
                    {
                        channel: 'WECHAT',
                        _count: { _all: 3 },
                        _sum: { amount: 50000 },
                    },
                ])
                .mockResolvedValueOnce([
                    {
                        policyCode: 'PRORATED',
                        _count: { _all: 2 },
                        _sum: { amount: 30000 },
                    },
                    {
                        policyCode: null,
                        _count: { _all: 1 },
                        _sum: { amount: 20000 },
                    },
                ]);
            prisma.refund.findMany.mockResolvedValue([
                { failureReason: 'seller balance is not enough' },
                { failureReason: 'seller balance is not enough' },
                { failureReason: 'WeChat refund status: CLOSED' },
                { failureReason: null },
            ]);

            const stats = await service.stats({});

            expect(stats.total).toEqual({
                count: 3,
                amount: 50000,
                settledAmount: 40000,
            });
            expect(stats.byStatus).toEqual([
                { status: 'SUCCESS', count: 2, amount: 30000 },
                { status: 'FAILED', count: 1, amount: 20000 },
            ]);
            expect(stats.byChannel).toEqual([
                { channel: 'WECHAT', count: 3, amount: 50000 },
            ]);
            // 没有政策码的历史记录归到 UNKNOWN，而不是被丢掉
            expect(stats.byPolicy).toContainEqual({
                policyCode: 'UNKNOWN',
                count: 1,
                amount: 20000,
            });
            // 失败原因按出现次数倒序
            expect(stats.failures[0]).toEqual({
                reason: 'seller balance is not enough',
                count: 2,
            });
        });

        it('truncates long failure reasons so one cause does not split into many', async () => {
            const { service, prisma } = createService();
            prisma.refund.aggregate.mockResolvedValue({
                _count: { _all: 0 },
                _sum: { amount: null, settledAmount: null },
            });
            prisma.refund.groupBy
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);
            const longReason = `Alipay refund failed: ${'x'.repeat(200)}`;
            prisma.refund.findMany.mockResolvedValue([
                { failureReason: longReason },
                { failureReason: longReason },
            ]);

            const stats = await service.stats({});

            expect(stats.failures).toHaveLength(1);
            expect(stats.failures[0].count).toBe(2);
            expect(stats.failures[0].reason.length).toBe(100);
        });

        it('filters by organization, channel and date range', async () => {
            const { service, prisma } = createService();
            prisma.refund.aggregate.mockResolvedValue({
                _count: { _all: 0 },
                _sum: { amount: null, settledAmount: null },
            });
            prisma.refund.groupBy
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);
            prisma.refund.findMany.mockResolvedValue([]);

            await service.stats({
                organizationId: 'org-1',
                channel: 'ALIPAY',
                from: '2026-01-01T00:00:00.000Z',
                to: '2026-02-01T00:00:00.000Z',
            });

            const where = prisma.refund.aggregate.mock.calls[0][0].where;

            expect(where.organizationId).toBe('org-1');
            expect(where.channel).toBe('ALIPAY');
            expect(where.createdAt.gte).toEqual(
                new Date('2026-01-01T00:00:00.000Z'),
            );
            expect(where.createdAt.lte).toEqual(
                new Date('2026-02-01T00:00:00.000Z'),
            );
        });
    });

    describe('create', () => {
        it('delegates to RefundService and re-reads the flattened row', async () => {
            const { service, prisma, refunds } = createService();
            refunds.create.mockResolvedValue({ id: 'refund-1' });
            prisma.refund.findUnique.mockResolvedValue(refundRow);

            const entity = await service.create(
                { orderId: 'order-1', reason: 'not satisfied' },
                'admin-1',
            );

            expect(refunds.create).toHaveBeenCalledWith({
                orderId: 'order-1',
                type: undefined,
                amount: undefined,
                reason: 'not satisfied',
                requestedBy: 'admin-1',
            });
            expect(entity.orderNo).toBe('BW1');
            expect(entity.status).toBe('SUCCESS');
        });
    });
});
