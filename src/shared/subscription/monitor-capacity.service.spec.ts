import {
    fixture,
    START,
    HOUR,
    free,
    pro,
} from '../../../test/fixtures/subscription-capacity.fixture';
import { CAPACITY_GRACE_MS, capacityRestricted } from './monitor-capacity.util';

describe('monitor capacity lifecycle', () => {
    it('anchors a lazy scan to expiry and enforces the exact 72-hour boundary', async () => {
        const { service, tx, monitors, cycles, notices } = fixture();
        await service.reconcile(
            tx,
            'org',
            free,
            new Date(START.getTime() + HOUR),
        );
        const deadline = new Date(START.getTime() + CAPACITY_GRACE_MS);
        expect(cycles[0]).toMatchObject({
            startsAt: START,
            graceEndsAt: deadline,
            retainedMonitorIds: ['a'],
            restrictedMonitorIds: [],
        });
        expect(capacityRestricted(monitors[1], new Date(+deadline - 1))).toBe(
            false,
        );
        expect(capacityRestricted(monitors[1], deadline)).toBe(true);
        await service.reconcile(tx, 'org', free, new Date(+deadline - 1));
        await service.reconcile(tx, 'org', free, deadline);
        await service.reconcile(tx, 'org', free, new Date(+deadline + HOUR));
        expect(cycles).toHaveLength(1);
        expect(cycles[0].graceEndsAt).toEqual(deadline);
        expect(cycles[0].restrictedMonitorIds).toEqual(['b', 'c']);
        expect([
            ...new Map(
                notices.publish.mock.calls.map((call: any) => [
                    call[0].eventKey,
                    call[0].type,
                ]),
            ).values(),
        ]).toEqual([
            'MONITOR_CAPACITY_GRACE_STARTED',
            'MONITOR_CAPACITY_GRACE_ENDING',
            'MONITOR_CAPACITY_LIMITED',
        ]);
        expect((notices.publish.mock.calls[2] as any)[0]).toMatchObject({
            email: true,
            meta: { stopped: 1, manuallyPaused: 1 },
            actionUrl: 'https://beacon.example/?organizationId=org',
        });
    });

    it.each([50, 80])(
        'sends only the actionable stage after a %s-hour outage',
        async (hours) => {
            const { service, tx, notices } = fixture();
            await service.reconcile(
                tx,
                'org',
                free,
                new Date(+START + hours * HOUR),
            );
            expect(notices.publish).toHaveBeenCalledTimes(1);
            expect((notices.publish.mock.calls[0] as any)[0].type).toBe(
                hours < 72
                    ? 'MONITOR_CAPACITY_GRACE_ENDING'
                    : 'MONITOR_CAPACITY_LIMITED',
            );
        },
    );

    it('fills unused retained slots stably and rejects duplicate, foreign, stale selections', async () => {
        const { service, tx, cycles } = fixture();
        await service.reconcile(tx, 'org', free, START);
        const cycle = cycles[0];
        for (const ids of [['a', 'b'], ['a', 'a'], ['foreign']]) {
            await expect(
                service.select(tx, 'org', cycle.id, ids),
            ).rejects.toThrow();
        }
        await expect(
            service.select(tx, 'other-org', cycle.id, ['a']),
        ).rejects.toThrow();
        await expect(
            service.select(tx, 'org', 'old-cycle', ['a']),
        ).rejects.toThrow();
        await service.select(tx, 'org', cycle.id, ['b']);
        await service.reconcile(tx, 'org', free, START);
        expect(cycle.retainedMonitorIds).toEqual(['b']);
        await service.select(tx, 'org', cycle.id, []);
        await service.reconcile(tx, 'org', free, START);
        expect(cycle.retainedMonitorIds).toEqual(['a']);
    });

    it('clears restrictions on upgrade, fences stale observations, and preserves manual pause', async () => {
        const { service, tx, monitors, cycles, notices } = fixture();
        const now = new Date(+START + 80 * HOUR);
        await service.reconcile(tx, 'org', free, now);
        await service.reconcile(tx, 'org', pro, now);
        expect(cycles[0].status).toBe('RESOLVED');
        expect(monitors.every((m) => m.quotaGraceEndsAt === null)).toBe(true);
        expect(monitors[1]).toMatchObject({
            revision: 2,
            configRevision: 2,
            enabled: true,
        });
        expect(monitors[2]).toMatchObject({
            revision: 2,
            configRevision: 2,
            enabled: false,
        });
        expect(tx.monitorState.updateMany).toHaveBeenLastCalledWith(
            expect.objectContaining({
                where: { monitorId: { in: ['b'] } },
                data: expect.objectContaining({
                    status: 'UNKNOWN',
                    lastAppliedObservationAt: null,
                }),
            }),
        );
        await service.reconcile(tx, 'org', pro, now);
        expect(
            new Set(
                notices.publish.mock.calls.map((call: any) => call[0].eventKey),
            ).size,
        ).toBe(2);
    });

    it('preserves earlier exclusion deadlines through a second downgrade', async () => {
        const { service, tx, monitors } = fixture();
        const middle = {
            id: 'middle',
            name: 'Middle',
            maxMonitors: 2,
            sortOrder: 1,
        };
        await service.reconcile(tx, 'org', middle, START);
        tx.subscription.findFirst.mockResolvedValue({
            id: 'middle-sub',
            planId: 'middle',
            plan: middle,
            expiresAt: new Date(+START + 48 * HOUR),
            order: null,
        });
        await service.reconcile(tx, 'org', free, new Date(+START + 48 * HOUR));
        expect(monitors[2].quotaGraceEndsAt).toEqual(
            new Date(+START + 72 * HOUR),
        );
        expect(monitors[1].quotaGraceEndsAt).toEqual(
            new Date(+START + 120 * HOUR),
        );
    });

    it('replays missed stacked expiries with separate deadlines and no obsolete grace mail', async () => {
        const { service, tx, monitors, notices, cycles } = fixture();
        const middle = {
            id: 'middle',
            name: 'Middle',
            maxMonitors: 2,
            sortOrder: 1,
        };
        const secondExpiry = new Date(+START + 7 * 24 * HOUR);
        tx.subscription.findMany.mockResolvedValue([
            {
                id: 'subscription',
                planId: 'pro',
                plan: pro,
                startsAt: new Date(+START - HOUR),
                expiresAt: START,
                order: { userId: 'payer' },
            },
            {
                id: 'middle-sub',
                planId: 'middle',
                plan: middle,
                startsAt: START,
                expiresAt: secondExpiry,
                order: { userId: 'payer' },
            },
        ]);
        await service.reconcile(
            tx,
            'org',
            free,
            new Date(+secondExpiry + HOUR),
        );
        expect(monitors[2].quotaGraceEndsAt).toEqual(
            new Date(+START + 72 * HOUR),
        );
        expect(monitors[1].quotaGraceEndsAt).toEqual(
            new Date(+secondExpiry + 72 * HOUR),
        );
        expect(cycles).toHaveLength(2);
        expect(cycles[1].restrictedMonitorIds).toEqual(['c']);
        expect(notices.publish).toHaveBeenCalledTimes(1);
        expect((notices.publish.mock.calls[0] as any)[0].type).toBe(
            'MONITOR_CAPACITY_LIMITED',
        );
    });

    it('does not start a cycle or scan monitors on ordinary unchanged-plan reads', async () => {
        const { service, tx, notices, cycles } = fixture();
        await service.reconcile(tx, 'org', pro, START);
        expect(tx.monitor.findMany).not.toHaveBeenCalled();
        expect(cycles).toHaveLength(0);
        expect(notices.publish).not.toHaveBeenCalled();
    });

    it('replays a queued upgrade and expiry even when the initial and final plans are FREE', async () => {
        const { service, tx, cycles, monitors } = fixture();
        await service.reconcile(tx, 'org', free, START);
        const middle = {
            id: 'middle',
            name: 'Middle',
            maxMonitors: 2,
            sortOrder: 1,
        };
        const startsAt = new Date(+START + 24 * HOUR);
        const expiresAt = new Date(+START + 7 * 24 * HOUR);
        tx.subscription.findMany.mockResolvedValue([
            {
                id: 'queued',
                planId: middle.id,
                plan: middle,
                startsAt,
                expiresAt,
                order: null,
            },
        ]);
        await service.reconcile(tx, 'org', free, new Date(+expiresAt + HOUR));
        expect(cycles).toHaveLength(2);
        expect(cycles[0].status).toBe('RESOLVED');
        expect(cycles[1].startsAt).toEqual(expiresAt);
        expect(monitors[1].quotaGraceEndsAt).toEqual(
            new Date(+expiresAt + 72 * HOUR),
        );
        // Third monitor never fit the intermediate plan, so its original limit remains.
        expect(monitors[2].quotaGraceEndsAt).toEqual(
            new Date(+START + 72 * HOUR),
        );
    });

    it('treats resumed frozen days as continuous capacity instead of inventing a FREE gap', async () => {
        const { service, tx, cycles, monitors, notices } = fixture();
        const now = new Date(+START + 80 * HOUR);
        const middle = {
            id: 'middle',
            name: 'Middle',
            maxMonitors: 5,
            sortOrder: 1,
        };
        tx.subscription.findMany.mockResolvedValue([
            {
                id: 'subscription',
                planId: 'pro',
                plan: pro,
                startsAt: new Date(+START - HOUR),
                expiresAt: START,
                order: null,
            },
            {
                id: 'resumed',
                planId: 'middle',
                plan: middle,
                startsAt: now,
                expiresAt: new Date(+now + 240 * HOUR),
                order: null,
            },
        ]);
        await service.reconcile(tx, 'org', middle, now, {
            resumedSubscriptionId: 'resumed',
        });
        expect(cycles).toHaveLength(0);
        expect(notices.publish).not.toHaveBeenCalled();
        expect(
            monitors.every(
                (m) => m.revision === 1 && m.quotaGraceEndsAt === null,
            ),
        ).toBe(true);
    });
});
