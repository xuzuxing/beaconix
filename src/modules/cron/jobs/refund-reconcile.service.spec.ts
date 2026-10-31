import { RefundStatus } from '../../../generated/prisma/enums';
import type { PrismaService } from '../../../infra/database/prisma.service';
import type { ScheduledJobRegistry } from '../../../infra/scheduler/scheduled-job.registry';
import type { RefundService } from '../../billing/refund/refund.service';
import { RefundReconcileService } from './refund-reconcile.service';

function createService() {
    const registry = { register: jest.fn() };
    const prisma = {
        refund: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const refunds = {
        syncFromChannel: jest
            .fn()
            .mockResolvedValue({ id: 'r1', status: RefundStatus.SUCCESS }),
    };

    const service = new RefundReconcileService(
        registry as unknown as ScheduledJobRegistry,
        prisma as unknown as PrismaService,
        refunds as unknown as RefundService,
    );

    return { service, registry, prisma, refunds };
}

describe('RefundReconcileService', () => {
    it('registers itself on the shared scheduler', () => {
        const { service, registry } = createService();

        service.onModuleInit();

        expect(registry.register).toHaveBeenCalledWith({
            name: 'refund-reconcile',
            pattern: '*/5 * * * *',
            handler: expect.any(Function),
        });
    });

    it('only scans refunds that are still pending after the grace period', async () => {
        const { service, prisma } = createService();

        await service.handleReconcile();

        const where = prisma.refund.findMany.mock.calls[0][0].where;

        expect(where.status).toBe(RefundStatus.PROCESSING);
        expect(where.submittedAt).toEqual({ not: null });
        expect(where.updatedAt.lt).toBeInstanceOf(Date);
    });

    it('settles the stale refunds through the shared channel sync', async () => {
        const { service, prisma, refunds } = createService();
        prisma.refund.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);

        const result = await service.handleReconcile();

        expect(refunds.syncFromChannel).toHaveBeenCalledTimes(2);
        expect(result).toEqual({
            checked: 2,
            settled: 2,
            stillProcessing: 0,
        });
    });

    it('counts FAILED refunds as no longer processing', async () => {
        const { service, prisma, refunds } = createService();
        prisma.refund.findMany.mockResolvedValue([{ id: 'r1' }]);
        refunds.syncFromChannel.mockResolvedValue({
            id: 'r1',
            status: RefundStatus.FAILED,
        });

        await expect(service.handleReconcile()).resolves.toMatchObject({
            checked: 1,
            settled: 0,
            stillProcessing: 0,
        });
    });

    it('keeps going when one refund lookup throws', async () => {
        const { service, prisma, refunds } = createService();
        prisma.refund.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
        refunds.syncFromChannel
            .mockRejectedValueOnce(new Error('channel down'))
            .mockResolvedValueOnce({
                id: 'r2',
                status: RefundStatus.SUCCESS,
            });

        await expect(service.handleReconcile()).resolves.toMatchObject({
            checked: 2,
            settled: 1,
            stillProcessing: 1,
        });
    });
});
