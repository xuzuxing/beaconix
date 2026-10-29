import { ConfigService } from '@nestjs/config';
import { SubscriptionExpiryService } from './subscription-expiry.service';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-11T12:00:00Z');
const pro = { id: 'pro', name: 'Pro', sortOrder: 2, maxMonitors: 100 };
const team = { id: 'team', name: 'Team', sortOrder: 1, maxMonitors: 20 };
const free = { id: 'free', name: 'Free', sortOrder: 0, maxMonitors: 5 };

function subscription(id: string, days: number, plan = pro) {
    return {
        id,
        organizationId: 'org',
        planId: plan.id,
        plan,
        expiresAt: new Date(NOW.getTime() + days * DAY),
        startsAt: new Date(NOW.getTime() - 30 * DAY),
        order: { userId: 'payer' },
    };
}

function createService(rows: ReturnType<typeof subscription>[]) {
    const tx = {
        $queryRaw: jest.fn(),
        subscription: {
            findMany: jest.fn().mockResolvedValue(rows),
            findFirst: jest.fn().mockResolvedValue(null),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        monitorCapacityCycle: { findFirst: jest.fn().mockResolvedValue(null) },
        monitor: { count: jest.fn().mockResolvedValue(0) },
        plan: { findUnique: jest.fn().mockResolvedValue(free) },
    };
    const prisma = {
        subscription: {
            findMany: jest.fn().mockResolvedValue([{ organizationId: 'org' }]),
        },
        $transaction: jest.fn((callback) => callback(tx)),
    };
    const notifications = {
        organizationRecipients: jest.fn().mockResolvedValue(['owner', 'admin']),
        publish: jest.fn().mockResolvedValue(undefined),
    };
    const registry = { register: jest.fn() };
    const service = new SubscriptionExpiryService(
        prisma as never,
        registry as never,
        notifications as never,
        {
            getEffectivePlanInTransaction: jest
                .fn()
                .mockImplementation(
                    () =>
                        rows
                            .filter((row) => row.expiresAt > NOW)
                            .sort(
                                (a, b) => b.plan.sortOrder - a.plan.sortOrder,
                            )[0]?.plan ?? free,
                ),
        } as never,
        new ConfigService({ app: { webUrl: 'https://beacon.example' } }),
    );
    return { service, prisma, tx, notifications, registry };
}

describe('SubscriptionExpiryService', () => {
    it('registers a minute capacity sweep alongside the existing expiry sweep', () => {
        const { service, registry } = createService([]);
        service.onModuleInit();
        expect(registry.register).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'monitor-capacity-sweep',
                pattern: '* * * * *',
            }),
        );
    });

    it('includes a precise UTC expiry, quantity impact and management link before expiry', async () => {
        const { service, tx, notifications } = createService([
            subscription('sub', 2),
        ]);
        tx.monitor.count.mockResolvedValue(10);
        await service.expireSubscriptions();
        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'SUBSCRIPTION_EXPIRING',
                email: true,
                body: expect.stringContaining('72 小时'),
                actionUrl: 'https://beacon.example/?organizationId=org',
            }),
            tx,
        );
    });

    it('avoids a duplicate generic expiry email when the capacity transition already emitted one', async () => {
        const { service, tx, notifications } = createService([
            subscription('sub', -1),
        ]);
        tx.monitorCapacityCycle.findFirst.mockResolvedValue({
            id: 'cycle',
        });
        expect(await service.expireSubscriptions()).toBe(1);
        expect(notifications.publish).not.toHaveBeenCalled();
    });
    beforeEach(() => {
        jest.useFakeTimers().setSystemTime(NOW);
    });
    afterEach(() => jest.useRealTimers());

    it.each([
        [6, 7],
        [2, 3],
        [0.5, 1],
    ])(
        'catches up at %s remaining days to only the closest %s-day milestone',
        async (remaining, milestone) => {
            const { service, tx, notifications } = createService([
                subscription('sub', remaining),
            ]);
            expect(await service.expireSubscriptions()).toBe(0);
            expect(notifications.publish).toHaveBeenCalledTimes(1);
            expect(notifications.publish).toHaveBeenCalledWith(
                expect.objectContaining({
                    eventKey: `subscription-expiring:sub:${new Date(NOW.getTime() + remaining * DAY).toISOString()}:${milestone}`,
                    type: 'SUBSCRIPTION_EXPIRING',
                    meta: { expiresAt: expect.any(String), days: milestone },
                    recipients: ['payer', 'owner', 'admin'],
                }),
                tx,
            );
            expect(tx.subscription.updateMany).not.toHaveBeenCalled();
        },
    );

    it('reuses a milestone key across repeated scans and changes it after renewal', async () => {
        const row = subscription('sub', 2);
        const { service, notifications } = createService([row]);
        await service.expireSubscriptions();
        await service.expireSubscriptions();
        const firstKey = notifications.publish.mock.calls[0][0].eventKey;
        expect(notifications.publish.mock.calls[1][0].eventKey).toBe(firstKey);
        row.expiresAt = new Date(NOW.getTime() + 3 * DAY);
        await service.expireSubscriptions();
        expect(notifications.publish.mock.calls[2][0].eventKey).not.toBe(
            firstKey,
        );
    });

    it('announces actual expiry without claiming a downgrade when another Pro subscription remains', async () => {
        const { service, tx, notifications } = createService([
            subscription('remaining', 30),
            subscription('expired', -1),
        ]);
        expect(await service.expireSubscriptions()).toBe(1);
        expect(tx.subscription.updateMany).toHaveBeenCalledWith({
            where: { id: 'expired', status: 'ACTIVE', expiresAt: { lte: NOW } },
            data: { status: 'EXPIRED' },
        });
        expect(notifications.publish).toHaveBeenCalledTimes(1);
        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'SUBSCRIPTION_EXPIRED',
                body: expect.stringContaining('effective plan remains Pro'),
                meta: expect.objectContaining({
                    effectivePlanChanged: false,
                    effectivePlanId: 'pro',
                }),
            }),
            tx,
        );
    });

    it('does not announce a plan change when a lower stacked subscription expires', async () => {
        const { service, notifications } = createService([
            subscription('remaining', 30),
            subscription('expired', -1, team),
        ]);
        await service.expireSubscriptions();
        expect(
            notifications.publish.mock.calls[0][0].meta.effectivePlanChanged,
        ).toBe(false);
    });

    it('announces the new effective plan when the last highest-priority subscription expires', async () => {
        const { service, notifications } = createService([
            subscription('expired', -1),
            subscription('remaining', 30, team),
        ]);
        await service.expireSubscriptions();
        expect(notifications.publish.mock.calls[0][0]).toMatchObject({
            body: 'The Pro subscription expired. The effective plan is now Team.',
            meta: {
                effectivePlanChanged: true,
                effectivePlanId: 'team',
                previousPlanId: 'pro',
            },
        });
    });

    it('uses the free fallback when all subscriptions expire', async () => {
        const { service, notifications } = createService([
            subscription('expired', -1),
        ]);
        await service.expireSubscriptions();
        expect(notifications.publish.mock.calls[0][0].meta).toMatchObject({
            effectivePlanChanged: true,
            effectivePlanId: 'free',
        });
    });

    it('does not publish a no-op expiry claimed by another sweep', async () => {
        const { service, tx, notifications } = createService([
            subscription('expired', -1),
        ]);
        tx.subscription.updateMany.mockResolvedValue({ count: 0 });
        expect(await service.expireSubscriptions()).toBe(0);
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it('fails the expiry transaction when the notice cannot be persisted', async () => {
        const { service, notifications } = createService([
            subscription('expired', -1),
        ]);
        notifications.publish.mockRejectedValue(
            new Error('outbox unavailable'),
        );
        await expect(service.expireSubscriptions()).rejects.toThrow(
            'outbox unavailable',
        );
    });
});
