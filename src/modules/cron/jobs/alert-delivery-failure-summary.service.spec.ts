import { AlertDeliveryFailureSummaryService } from './alert-delivery-failure-summary.service';

function fixture() {
    const db: any = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'org' }]),
        $transaction: jest.fn((work) => work(db)),
        alertDelivery: { count: jest.fn().mockResolvedValue(3) },
    };
    const notifications = {
        organizationRecipients: jest.fn().mockResolvedValue(['owner', 'admin']),
        publish: jest.fn(),
    };
    const registry = { register: jest.fn() };
    return {
        db,
        notifications,
        registry,
        service: new AlertDeliveryFailureSummaryService(
            db,
            notifications as never,
            registry as never,
        ),
    };
}

describe('Daily failed channel delivery summary', () => {
    it('registers 09:00 Shanghai and uses the same timezone for the stable daily key', async () => {
        const f = fixture();
        f.service.onModuleInit();
        expect(f.registry.register).toHaveBeenCalledWith(
            expect.objectContaining({
                pattern: '0 9 * * *',
                timezone: 'Asia/Shanghai',
            }),
        );
        await f.service.summarize(new Date('2026-10-30T17:00:00Z'));
        expect(f.notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                eventKey: 'alert-delivery-failures:org:2026-10-31',
                type: 'ALERT_DELIVERY_FAILED_SUMMARY',
                recipients: ['owner', 'admin'],
                organizationId: 'org',
                accessScope: 'ORGANIZATION',
                email: true,
                meta: {
                    failedCount: 3,
                    day: '2026-10-31',
                    timezone: 'Asia/Shanghai',
                },
            }),
            f.db,
        );
        expect(f.db.alertDelivery.count).toHaveBeenCalledWith({
            where: { status: 'FAILED', event: { organizationId: 'org' } },
        });
    });

    it('does not notify if retries have already removed the failed backlog', async () => {
        const f = fixture();
        f.db.alertDelivery.count.mockResolvedValue(0);
        await f.service.summarize();
        expect(f.notifications.publish).not.toHaveBeenCalled();
    });

    it('keeps the key stable when counts change within a day and advances it on the next day', async () => {
        const f = fixture();
        for (const at of [
            '2026-10-30T01:00:00Z',
            '2026-10-30T02:00:00Z',
            '2026-10-31T01:00:00Z',
        ])
            await f.service.summarize(new Date(at));
        const keys = f.notifications.publish.mock.calls.map(
            ([event]) => event.eventKey,
        );
        expect(keys[0]).toBe(keys[1]);
        expect(keys[2]).not.toBe(keys[1]);
    });

    it('separates tenant counts and recipients', async () => {
        const f = fixture();
        f.db.$queryRaw.mockResolvedValue([{ id: 'org-a' }, { id: 'org-b' }]);
        f.db.alertDelivery.count
            .mockResolvedValueOnce(2)
            .mockResolvedValueOnce(8);
        f.notifications.organizationRecipients.mockImplementation((id) => [
            `${id}-owner`,
        ]);
        await f.service.summarize();
        expect(
            f.notifications.publish.mock.calls.map(([event]) => [
                event.organizationId,
                event.recipients,
                event.meta.failedCount,
            ]),
        ).toEqual([
            ['org-a', ['org-a-owner'], 2],
            ['org-b', ['org-b-owner'], 8],
        ]);
    });
});
