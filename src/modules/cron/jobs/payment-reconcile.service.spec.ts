import { PaymentReconcileService } from './payment-reconcile.service';
import { OrderExpiryService } from '../../billing/order/order-expiry.service';

describe('Payment scheduled jobs', () => {
    it('registers the shared payment sweep every five minutes', async () => {
        const registry = { register: jest.fn() };
        const payments = {
            reconcilePendingAttempts: jest
                .fn()
                .mockResolvedValue({ checked: 2, settled: 1 }),
        };
        new PaymentReconcileService(
            registry as never,
            payments as never,
        ).onModuleInit();
        const job = registry.register.mock.calls[0][0];
        expect(job.pattern).toBe('*/5 * * * *');
        expect(await job.handler()).toEqual({ checked: 2, settled: 1 });
    });

    it('continues expiry cancellation after one failure and never counts a concurrently paid order', async () => {
        const prisma = {
            order: {
                findMany: jest
                    .fn()
                    .mockResolvedValue([
                        { id: 'error' },
                        { id: 'paid' },
                        { id: 'expired' },
                    ]),
            },
        };
        const payments = {
            cancelOrder: jest
                .fn()
                .mockRejectedValueOnce(new Error('temporary failure'))
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(true),
        };
        const service = new OrderExpiryService(
            prisma as never,
            {} as never,
            payments as never,
        );
        expect(await service.cancelExpiredOrders()).toBe(1);
        expect(payments.cancelOrder.mock.calls).toEqual([
            ['error', true],
            ['paid', true],
            ['expired', true],
        ]);
        expect(prisma.order.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                take: 100,
                where: {
                    status: 'PENDING',
                    expiresAt: { lte: expect.any(Date) },
                },
            }),
        );
    });
});
