import { fixture } from '../../../test/fixtures/monitoring-lifecycle.fixture';
import { noDataTimeoutMs } from '../state/no-data-policy';

describe('No-data lifecycle with real state and alert services (offline)', () => {
    afterEach(() => jest.useRealTimers());

    it.each([
        ['record', false],
        ['record', true],
        ['settle', false],
        ['settle', true],
    ] as const)(
        'keeps SSL_INVALID reconciliation through %s (active NO_DATA=%s)',
        async (path, activeNoData) => {
            const f = fixture();
            f.monitor.checkSsl = true;
            f.monitor.sslExpiryThreshold = 30;
            jest.useFakeTimers().setSystemTime(f.now);
            const effectiveAt = f.state.lastEffectiveObservationAt;
            if (activeNoData) await f.sweep.mark('monitor', f.now);
            const checkedAt = new Date(f.now.getTime() + 1000);
            jest.setSystemTime(checkedAt);
            const result = {
                success: false,
                latency: 10,
                serviceVerdict: 'NO_EVIDENCE',
                sslVerdict: 'INVALID',
                error: 'certificate validation failed',
                checkedAt,
                configRevision: 1,
                revision: 1,
                aggregation: {},
            };
            if (path === 'record') {
                await f.observations.record('monitor', result as never);
            } else {
                f.logs.set('ssl-round', {
                    id: 'ssl-log',
                    checkedAt,
                    evaluated: true,
                    appliedAt: null,
                });
                await f.observations.settle(
                    'monitor',
                    'ssl-round',
                    result as never,
                );
            }
            expect(
                f.events.find((event) => event.kind === 'SSL'),
            ).toMatchObject({ reason: 'SSL_INVALID', status: 'ongoing' });
            expect(
                f.deliveries.some(
                    (delivery) =>
                        delivery.eventId ===
                        f.events.find((event) => event.kind === 'SSL').id,
                ),
            ).toBe(true);
            expect(f.state.lastEffectiveObservationAt).toEqual(effectiveAt);
            if (activeNoData) {
                expect(f.state).toMatchObject({
                    noDataSince: f.now,
                    status: 'UNKNOWN',
                    executionBlockedReason: 'NO_DATA',
                });
                expect(
                    f.events.find((event) => event.kind === 'NO_DATA').status,
                ).toBe('ongoing');
                expect(
                    f.deliveries.filter(
                        (delivery) =>
                            delivery.payload.event === 'NO_DATA_RECOVERED',
                    ),
                ).toHaveLength(0);
            }
        },
    );

    it('uses a ten-minute floor and three intervals for slower monitors', () => {
        expect(noDataTimeoutMs(60)).toBe(600000);
        expect(noDataTimeoutMs(300)).toBe(900000);
    });

    it('marks UNKNOWN once, preserves observation clocks/history and plans one OPEN', async () => {
        const f = fixture();
        const lastCheck = f.state.lastCheckAt;
        expect(await f.sweep.mark('monitor', f.now)).toBe(true);
        expect(await f.sweep.mark('monitor', f.now)).toBe(false);
        expect(f.state).toMatchObject({
            status: 'UNKNOWN',
            noDataSince: f.now,
            executionBlockedReason: 'NO_DATA',
            lastCheckAt: lastCheck,
        });
        expect(f.events).toHaveLength(1);
        expect(f.events[0]).toMatchObject({
            kind: 'NO_DATA',
            status: 'ongoing',
        });
        expect(f.deliveries).toHaveLength(1);
        expect(f.deliveries[0].payload).toMatchObject({
            event: 'NO_DATA',
            status: 'UNKNOWN',
            latency: null,
        });
        expect(f.prisma.checkLog.create).not.toHaveBeenCalled();
    });

    it.each([
        [
            'paused',
            (f) => {
                f.monitor.enabled = false;
            },
        ],
        [
            'quota limited',
            (f) => {
                f.monitor.quotaGraceEndsAt = f.now;
            },
        ],
        [
            'recent effective observation',
            (f) => {
                f.state.lastEffectiveObservationAt = new Date(
                    f.now.getTime() - 1000,
                );
            },
        ],
        [
            'recently re-enabled or edited',
            (f) => {
                f.monitor.updatedAt = f.now;
            },
        ],
        [
            'freshly created',
            (f) => {
                f.monitor.createdAt = f.now;
            },
        ],
    ])(
        'excludes %s after acquiring the observation lock',
        async (_name, change) => {
            const f = fixture();
            change(f);
            expect(await f.sweep.mark('monitor', f.now)).toBe(false);
            expect(f.prisma.$queryRaw).toHaveBeenCalledTimes(2);
            expect(f.events).toHaveLength(0);
        },
    );

    it('rechecks the effective observation under lock after the candidate scan', async () => {
        const f = fixture();
        f.prisma.$queryRaw.mockResolvedValueOnce([{ id: 'monitor' }]);
        f.prisma.monitor.findFirst.mockImplementationOnce(() => ({
            ...f.monitor,
            state: { ...f.state, lastEffectiveObservationAt: f.now },
        }));
        await f.sweep.sweep(f.now);
        expect(f.events).toHaveLength(0);
    });

    it('pending local checks do not refresh the effective observation clock', async () => {
        const f = fixture();
        f.state.lastCheckAt = f.now;
        f.state.lastLocalCheckAt = f.now;
        expect(await f.sweep.mark('monitor', f.now)).toBe(true);
    });

    it.each([true, false])(
        'ends NO_DATA on a fresh effective observation (success=%s)',
        async (success) => {
            const f = fixture();
            jest.useFakeTimers().setSystemTime(f.now);
            await f.sweep.mark('monitor', f.now);
            const checkedAt = new Date(f.now.getTime() + 1000);
            jest.setSystemTime(checkedAt);
            await f.observations.record('monitor', {
                success,
                latency: 10,
                checkedAt,
                serviceVerdict: success ? 'SUCCESS' : 'FAILURE',
            });
            expect(f.state).toMatchObject({
                status: success ? 'UP' : 'DOWN',
                noDataSince: null,
                lastEffectiveObservationAt: checkedAt,
            });
            expect(f.events[0].status).toBe('resolved');
            expect(
                f.deliveries
                    .filter((d) => d.eventId === f.events[0].id)
                    .map((d) => d.payload.event),
            ).toEqual(['NO_DATA', 'NO_DATA_RECOVERED']);
            expect(f.notifications.eventRecipients).toHaveBeenCalledWith(
                'monitor-incident:event-0:OPEN',
                f.prisma,
            );
            await f.observations.record('monitor', {
                success,
                latency: 10,
                checkedAt,
                observationId: 'second',
            });
            expect(
                f.deliveries.filter((d) => d.eventId === f.events[0].id),
            ).toHaveLength(2);
        },
    );

    it.each([
        { evaluated: false },
        { serviceVerdict: 'NO_EVIDENCE' },
        { checkedAt: new Date('2026-10-30T03:59:59Z') },
        { source: 'PROBE', checkedAt: new Date('2026-10-30T03:00:00Z') },
        { checkedAt: new Date('2026-10-30T05:00:00Z') },
    ])(
        'does not recover from ineffective, old or future results: %j',
        async (overrides) => {
            const f = fixture();
            jest.useFakeTimers().setSystemTime(f.now);
            await f.sweep.mark('monitor', f.now);
            jest.setSystemTime(new Date(f.now.getTime() + 1000));
            await f.observations.record('monitor', {
                success: true,
                latency: 1,
                ...overrides,
            } as never);
            expect(f.state).toMatchObject({
                status: 'UNKNOWN',
                noDataSince: f.now,
                executionBlockedReason: 'NO_DATA',
            });
            expect(f.events[0].status).toBe('ongoing');
            expect(f.deliveries).toHaveLength(1);
        },
    );

    it('consumes a delayed round without applying state or emitting recovery', async () => {
        const f = fixture();
        jest.useFakeTimers().setSystemTime(f.now);
        await f.sweep.mark('monitor', f.now);
        f.logs.set('round', {
            id: 'log',
            checkedAt: new Date(f.now.getTime() - 1000),
            evaluated: true,
            appliedAt: null,
        });
        jest.setSystemTime(new Date(f.now.getTime() + 1000));
        expect(
            await f.observations.settle('monitor', 'round', {
                success: true,
                serviceVerdict: 'SUCCESS',
                configRevision: 1,
                revision: 1,
                aggregation: {},
            } as never),
        ).toBeNull();
        expect(f.prisma.checkLog.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ appliedAt: expect.any(Date) }),
            }),
        );
        expect(f.state.noDataSince).toEqual(f.now);
        expect(f.events[0].status).toBe('ongoing');
    });

    it('recovers from a freshly settled round exactly once', async () => {
        const f = fixture();
        jest.useFakeTimers().setSystemTime(f.now);
        await f.sweep.mark('monitor', f.now);
        const checkedAt = new Date(f.now.getTime() + 1000);
        f.logs.set('round', {
            id: 'log',
            observationId: 'obs',
            checkedAt,
            evaluated: true,
            appliedAt: null,
        });
        jest.setSystemTime(checkedAt);
        await f.observations.settle('monitor', 'round', {
            success: true,
            latency: 1,
            serviceVerdict: 'SUCCESS',
            configRevision: 1,
            revision: 1,
            aggregation: {},
        } as never);
        expect(f.state).toMatchObject({
            status: 'UP',
            noDataSince: null,
            lastEffectiveObservationAt: checkedAt,
        });
        expect(f.events[0].status).toBe('resolved');
        expect(f.deliveries).toHaveLength(2);
    });
});
