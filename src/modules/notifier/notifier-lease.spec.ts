import { fixture } from '../../../test/fixtures/monitoring-lifecycle.fixture';

describe('Alert delivery completion ownership', () => {
    afterEach(() => jest.useRealTimers());
    it.each(['reclaimed', 'expired', 'expired-before-renewal'])(
        'does not acknowledge a %s lease',
        async (mode) => {
            const f = fixture();
            jest.useFakeTimers().setSystemTime(f.now);
            await f.observations.record('monitor', {
                revision: 1,
                configRevision: 1,
                checkedAt: f.now,
                success: false,
                latency: 1,
            });
            const delivery = f.deliveries[0];
            f.sender.send.mockImplementationOnce(async () => {
                if (mode === 'reclaimed') delivery.leaseToken = 'new-owner';
                else jest.setSystemTime(Date.now() + 121_000);
                if (mode === 'expired-before-renewal') {
                    const expiredAt = delivery.leaseUntil;
                    await jest.advanceTimersByTimeAsync(30_000);
                    expect(delivery.leaseUntil).toEqual(expiredAt);
                }
            });
            await f.notifier.deliverAlertDelivery(delivery.id);
            expect(delivery.status).toBe('SENDING');
            if (mode === 'reclaimed')
                expect(delivery.leaseToken).toBe('new-owner');
            expect(f.sentLogs).toHaveLength(0);
            expect(f.events[0].firstNotifiedAt).toBeUndefined();
        },
    );
});
