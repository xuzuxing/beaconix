import { AlertOutboxService } from './alert-outbox.service';

function fixture() {
    const prisma = {
        alertDelivery: {
            findMany: jest.fn(),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
    };
    const queue = { add: jest.fn().mockResolvedValue({}) };
    const service = new AlertOutboxService(
        prisma as never,
        { register: jest.fn() } as never,
        queue as never,
    );
    const row = {
        id: 'delivery',
        channelId: 'channel',
        status: 'PENDING',
        leaseUntil: null,
        payload: { status: 'DOWN' },
    };
    return { prisma, queue, service, row };
}

describe('AlertOutboxService', () => {
    it('queues a durable logical ID with bounded retries without marking a successful send', async () => {
        const { service, prisma, queue, row } = fixture();
        prisma.alertDelivery.findMany.mockResolvedValue([row]);
        await service.dispatch();
        expect(queue.add).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ deliveryId: row.id }),
            expect.objectContaining({
                jobId: row.id,
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
            }),
        );
        expect(prisma.alertDelivery.updateMany).toHaveBeenCalledTimes(1);
        expect(
            prisma.alertDelivery.updateMany.mock.calls[0][0].data.status,
        ).toBe('QUEUED');
        expect(prisma.alertDelivery.findMany.mock.calls[0][0].where.OR).toEqual(
            [
                { status: 'PENDING' },
                {
                    status: { in: ['QUEUED', 'SENDING'] },
                    leaseUntil: { lt: expect.any(Date) },
                },
            ],
        );
    });

    it('does not enqueue when another dispatcher already claimed the row', async () => {
        const { service, prisma, queue, row } = fixture();
        prisma.alertDelivery.findMany.mockResolvedValue([row]);
        prisma.alertDelivery.updateMany.mockResolvedValue({ count: 0 });
        await service.dispatch();
        expect(queue.add).not.toHaveBeenCalled();
    });

    it('returns an enqueue failure to pending for a future sweep', async () => {
        const { service, prisma, queue, row } = fixture();
        prisma.alertDelivery.findMany.mockResolvedValue([row]);
        queue.add.mockRejectedValue(new Error('Redis unavailable'));
        await expect(service.dispatch()).resolves.toBe(1);
        expect(prisma.alertDelivery.updateMany).toHaveBeenLastCalledWith({
            where: { id: row.id, status: 'QUEUED' },
            data: expect.objectContaining({
                status: 'PENDING',
                leaseUntil: null,
                nextAttemptAt: expect.any(Date),
            }),
        });
    });

    it('reclaims expired sending leases after a worker exits', async () => {
        const { service, prisma, queue, row } = fixture();
        const expired = new Date(0);
        prisma.alertDelivery.findMany.mockResolvedValue([
            { ...row, status: 'SENDING', leaseUntil: expired },
        ]);
        await service.dispatch();
        expect(prisma.alertDelivery.updateMany).toHaveBeenCalledWith({
            where: { id: row.id, status: 'SENDING', leaseUntil: expired },
            data: expect.objectContaining({
                status: 'QUEUED',
                leaseToken: null,
            }),
        });
        expect(queue.add).toHaveBeenCalledTimes(1);
    });
});
