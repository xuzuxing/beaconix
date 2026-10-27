import { mockProjectAccess } from '../../common/authorization/access-test.fixture';
import { NotFoundException } from '@nestjs/common';
import { CheckSource, MonitorStatus } from '../../generated/prisma/enums';
import { deriveState, StateService } from './state.service';
import type { SettledRoundVerdict } from './state.service';
import type { PrismaService } from '../../infra/database/prisma.service';
import type { AlertEventsService } from '../alert-events/alert-events.service';

const monitorRow = {
    id: 'monitor-1',
    organizationId: 'org-1',
    projectId: 'project-1',
    name: 'Production API',
    type: 'HTTP',
    target: 'https://api.example.com/health',
    interval: 60,
    timeout: 5000,
    expectedStatus: 200,
    failureThreshold: 3,
    probeSuccessRatio: 1,
    checkSsl: false,
    sslExpiryThreshold: 30,
    enabled: true,
    revision: 1,
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
    deletedAt: null,
};

const stateRow = {
    monitorId: 'monitor-1',
    status: 'UNKNOWN',
    failCount: 0,
    lastCheckAt: null,
    lastError: null,
    lastLatency: null,
    lastNotifiedStatus: null,
    sslExpiresAt: null,
    sslDaysRemaining: null,
    sslIssuer: null,
    sslSubject: null,
    sslLastNotifiedAt: null,
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
};

function createService() {
    const prisma = {
        monitor: { findFirst: jest.fn() },
        monitorState: {
            upsert: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        checkLog: {
            create: jest.fn(),
            count: jest.fn(),
            aggregate: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        $queryRaw: jest.fn(),
        $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
        (callback: (tx: unknown) => unknown) => callback(prisma),
    );
    const alerts = {
        record: jest.fn().mockResolvedValue({
            deliveries: 0,
            availabilityAlertActive: false,
        }),
    };
    const service = new StateService(
        prisma as unknown as PrismaService,
        alerts as unknown as AlertEventsService,
        mockProjectAccess(prisma),
    );

    return { service, prisma, alerts };
}

describe('deriveState', () => {
    it('reports UP and clears the failure streak after a success', () => {
        const next = deriveState(
            { status: MonitorStatus.DOWN, failCount: 3 },
            true,
            3,
        );

        expect(next).toEqual({ status: MonitorStatus.UP, failCount: 0 });
    });

    it('reports DEGRADED while the failure streak is below the threshold', () => {
        const next = deriveState(
            { status: MonitorStatus.UP, failCount: 0 },
            false,
            3,
        );

        expect(next).toEqual({ status: MonitorStatus.DEGRADED, failCount: 1 });
    });

    it('reports DOWN once the failure streak reaches the threshold', () => {
        const next = deriveState(
            { status: MonitorStatus.DEGRADED, failCount: 2 },
            false,
            3,
        );

        expect(next).toEqual({ status: MonitorStatus.DOWN, failCount: 3 });
    });

    it('keeps a paused monitor paused', () => {
        const next = deriveState(
            { status: MonitorStatus.PAUSED, failCount: 0 },
            false,
            3,
        );

        expect(next).toEqual({ status: MonitorStatus.PAUSED, failCount: 0 });
    });
});

describe('StateService', () => {
    describe('settle', () => {
        const roundId = 'monitor-1:1700000000000';
        const pendingLog = {
            id: 'log-1',
            monitorId: 'monitor-1',
            roundId,
            appliedAt: null,
            observationId: 'obs-1',
            evaluated: true,
            checkedAt: new Date('2026-03-05T12:00:00.000Z'),
            meta: {
                aggregation: { protected: false, protectedReason: null },
            },
        };

        function roundVerdict(
            overrides: Partial<SettledRoundVerdict> = {},
        ): SettledRoundVerdict {
            return {
                roundId,
                success: true,
                error: null,
                latency: 12,
                statusCode: 200,
                localSuccess: true,
                rescuedByProbe: false,
                failureKind: null,
                serviceVerdict: 'SUCCESS',
                localServiceVerdict: 'SUCCESS',
                ruleMatched: false,
                ruleGroupIds: [],
                aggregation: {
                    protected: false,
                    protectedReason: null,
                    effectiveProbeCount: 2,
                    expectedProbeCount: 2,
                    tenantProbeCount: 2,
                    systemProbeCount: 0,
                    sampleCount: 2,
                    successCount: 2,
                    ratio: 100,
                    threshold: 100,
                    decision: 'CONFIRMED_SUCCESS',
                    settledAt: '2026-03-05T12:00:00.000Z',
                },
                configRevision: 1,
                revision: 1,
                ...overrides,
            };
        }

        it('folds a settled batch into the state row and marks the log applied', async () => {
            const { service, prisma, alerts } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                configRevision: 1,
                state: { ...stateRow, failCount: 2, connectivityFailCount: 2 },
            });
            prisma.checkLog.findUnique.mockResolvedValue(pendingLog);
            prisma.monitorState.upsert.mockResolvedValue(stateRow);

            const settled = await service.settle(
                'monitor-1',
                roundId,
                roundVerdict(),
            );

            expect(settled?.transition).toMatchObject({
                status: 'UP',
                failCount: 0,
                changed: true,
            });
            expect(prisma.checkLog.update).toHaveBeenCalledWith({
                where: { id: 'log-1' },
                data: expect.objectContaining({
                    success: true,
                    appliedAt: expect.any(Date),
                    meta: expect.objectContaining({
                        aggregation: expect.objectContaining({
                            decision: 'CONFIRMED_SUCCESS',
                        }),
                    }),
                }),
            });
            const stateData =
                prisma.monitorState.upsert.mock.calls[0][0].update;
            expect(stateData).toMatchObject({
                status: 'UP',
                failCount: 0,
                connectivityFailCount: 0,
                lastAppliedObservationAt: expect.any(Date),
            });
            // Settling must not move the local scheduling anchor.
            expect(stateData.lastLocalCheckAt).toBeUndefined();
            expect(alerts.record).toHaveBeenCalledTimes(1);
            expect(alerts.record.mock.calls[0][4].connectivityFailCount).toBe(
                0,
            );
        });

        it('counts a vetoed round as one connectivity failure', async () => {
            const { service, prisma, alerts } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                configRevision: 1,
                state: { ...stateRow, status: 'UP', connectivityFailCount: 0 },
            });
            prisma.checkLog.findUnique.mockResolvedValue(pendingLog);
            prisma.monitorState.upsert.mockResolvedValue({
                ...stateRow,
                status: 'DEGRADED',
                failCount: 1,
            });

            const settled = await service.settle(
                'monitor-1',
                roundId,
                roundVerdict({
                    success: false,
                    error: 'Probe success ratio 1/2 below 100%',
                    failureKind: 'AGGREGATE',
                    serviceVerdict: 'FAILURE',
                    aggregation: {
                        ...roundVerdict().aggregation,
                        successCount: 1,
                        decision: 'OVERTURNED',
                    },
                }),
            );

            expect(settled?.transition).toMatchObject({
                status: 'DEGRADED',
                failCount: 1,
            });
            expect(alerts.record.mock.calls[0][4].connectivityFailCount).toBe(
                1,
            );
            expect(prisma.checkLog.update.mock.calls[0][0].data).toMatchObject({
                failureKind: 'AGGREGATE',
                serviceVerdict: 'FAILURE',
                rescuedByProbe: false,
            });
        });

        it('reports the batch to the alert evaluator without notifying on a single failure', async () => {
            const { service, prisma, alerts } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                configRevision: 1,
                failureThreshold: 3,
                state: { ...stateRow, status: 'UP', connectivityFailCount: 0 },
            });
            prisma.checkLog.findUnique.mockResolvedValue(pendingLog);
            prisma.monitorState.upsert.mockResolvedValue({
                ...stateRow,
                status: 'DEGRADED',
                failCount: 1,
            });

            const settled = await service.settle(
                'monitor-1',
                roundId,
                roundVerdict({ success: false, serviceVerdict: 'FAILURE' }),
            );

            // The alert evaluator receives the derived counters; with
            // connectivityFailCount 1 < 3 it opens no CONNECTIVITY event.
            expect(alerts.record.mock.calls[0][4]).toMatchObject({
                failCount: 1,
                connectivityFailCount: 1,
            });
            expect(settled?.deliveries).toBe(0);
        });

        it('drops a batch that already settled', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: stateRow,
            });
            prisma.checkLog.findUnique.mockResolvedValue({
                ...pendingLog,
                appliedAt: new Date(),
            });

            expect(
                await service.settle('monitor-1', roundId, roundVerdict()),
            ).toBeNull();
            expect(prisma.monitorState.upsert).not.toHaveBeenCalled();
        });

        it('drops a batch whose definition changed while it was open', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                configRevision: 2,
                state: stateRow,
            });
            prisma.checkLog.findUnique.mockResolvedValue(pendingLog);

            expect(
                await service.settle('monitor-1', roundId, roundVerdict()),
            ).toBeNull();
            expect(prisma.checkLog.update).not.toHaveBeenCalled();
        });

        it('marks rows of older unsettled batches as applied', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                configRevision: 1,
                state: stateRow,
            });
            prisma.checkLog.findUnique.mockResolvedValue(pendingLog);
            prisma.monitorState.upsert.mockResolvedValue(stateRow);

            await service.settle('monitor-1', roundId, roundVerdict());

            expect(prisma.checkLog.updateMany).toHaveBeenCalledWith({
                where: {
                    monitorId: 'monitor-1',
                    appliedAt: null,
                    roundId: { not: null, notIn: [roundId] },
                },
                data: { appliedAt: expect.any(Date) },
            });
        });
    });

    describe('record', () => {
        it('does not let a legacy future probe timestamp freeze local state', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: {
                    ...stateRow,
                    lastCheckAt: new Date('2099-01-01T00:00:00Z'),
                },
            });
            prisma.monitorState.upsert.mockResolvedValue(stateRow);
            const at = new Date();
            expect(
                await service.record('monitor-1', {
                    revision: 1,
                    success: true,
                    latency: 10,
                    checkedAt: at,
                }),
            ).not.toBeNull();
            await service.record('monitor-1', {
                revision: 1,
                success: true,
                latency: 10,
                source: CheckSource.PROBE,
                checkedAt: new Date('2099-01-01T00:00:00Z'),
            });
            const probeLog = prisma.checkLog.create.mock.calls[1][0].data;
            expect(probeLog.checkedAt.getFullYear()).toBeLessThan(2099);
        });
        it.each([
            { enabled: false, revision: 1 },
            { enabled: true, revision: 2 },
        ])(
            'discards paused or superseded in-flight results: %j',
            async (change) => {
                const { service, prisma } = createService();
                prisma.monitor.findFirst.mockResolvedValue({
                    ...monitorRow,
                    ...change,
                    state: stateRow,
                });
                await expect(
                    service.record('monitor-1', {
                        success: false,
                        latency: 10,
                        revision: 1,
                    }),
                ).resolves.toBeNull();
                expect(prisma.checkLog.create).not.toHaveBeenCalled();
                expect(prisma.monitorState.upsert).not.toHaveBeenCalled();
                expect(prisma.$queryRaw).toHaveBeenCalled();
            },
        );

        it('does not write results for a monitor deleted during execution', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue(null);
            await expect(
                service.record('monitor-1', {
                    success: false,
                    latency: 10,
                    revision: 1,
                }),
            ).resolves.toBeNull();
            expect(prisma.checkLog.create).not.toHaveBeenCalled();
        });

        it('logs execution blocks without increasing failures or target downtime', async () => {
            const { service, prisma, alerts } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: { ...stateRow, status: 'UP' },
            });
            prisma.monitorState.upsert.mockResolvedValue(stateRow);
            const recorded = await service.record('monitor-1', {
                revision: 1,
                success: false,
                latency: 0,
                evaluated: false,
                failureKind: 'CAPABILITY',
                error: 'ICMP unavailable',
            });
            expect(recorded!.transition).toMatchObject({
                status: 'UP',
                failCount: 0,
                changed: false,
            });
            expect(prisma.monitorState.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    update: expect.objectContaining({
                        lastCheckAt: undefined,
                        lastError: undefined,
                        executionBlockedReason: 'ICMP unavailable',
                        lastLocalCheckAt: expect.any(Date),
                    }),
                }),
            );
            expect(prisma.checkLog.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    evaluated: false,
                    failureKind: 'CAPABILITY',
                    ruleMatched: false,
                }),
            });
            expect(alerts.record).not.toHaveBeenCalled();
        });

        it('discards configuration changes made by rule or protocol edits', async () => {
            const { service, prisma, alerts } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                configRevision: 2,
                state: stateRow,
            });
            await expect(
                service.record('monitor-1', {
                    revision: 1,
                    configRevision: 1,
                    success: false,
                    latency: 10,
                }),
            ).resolves.toBeNull();
            expect(prisma.checkLog.create).not.toHaveBeenCalled();
            expect(alerts.record).not.toHaveBeenCalled();
        });

        it('persists DNS metadata and revision alongside its assertion', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                revision: 3,
                state: stateRow,
            });
            prisma.monitorState.upsert.mockResolvedValue(stateRow);
            const meta = {
                protocol: 'DNS' as const,
                recordType: 'A' as const,
                actualValues: ['1.1.1.1'],
                ttl: [30],
            };
            await service.record('monitor-1', {
                revision: 3,
                success: true,
                latency: 5,
                meta,
            });
            expect(prisma.checkLog.create).toHaveBeenCalledWith({
                data: expect.objectContaining({ revision: 3, meta }),
            });
        });

        it('ignores results older than the state already committed', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: {
                    ...stateRow,
                    lastLocalCheckAt: new Date('2026-10-10T00:01:00Z'),
                },
            });
            expect(
                await service.record('monitor-1', {
                    revision: 1,
                    success: false,
                    latency: 1,
                    checkedAt: new Date('2026-10-10T00:00:00Z'),
                }),
            ).toBeNull();
            expect(prisma.checkLog.create).not.toHaveBeenCalled();
        });

        it('appends a check log and folds the outcome into the state row', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: { ...stateRow, status: 'UP', failCount: 0 },
            });
            prisma.checkLog.create.mockResolvedValue({ id: 'log-1' });
            prisma.monitorState.upsert.mockResolvedValue({
                ...stateRow,
                status: 'DEGRADED',
                failCount: 1,
            });

            const recorded = await service.record('monitor-1', {
                success: false,
                latency: 30,
                error: 'Unexpected status 500 (expected 200)',
                statusCode: 500,
            });
            const transition = recorded!.transition;

            expect(prisma.checkLog.create).toHaveBeenCalledWith({
                data: {
                    monitorId: 'monitor-1',
                    monitorRefId: 'monitor-1',
                    projectId: 'project-1',
                    organizationId: 'org-1',
                    monitorType: 'HTTP',
                    observationId: expect.any(String),
                    configRevision: undefined,
                    serviceVerdict: 'FAILURE',
                    localServiceVerdict: 'FAILURE',
                    sslVerdict: null,
                    success: false,
                    localSuccess: false,
                    rescuedByProbe: false,
                    latency: 30,
                    error: 'Unexpected status 500 (expected 200)',
                    statusCode: 500,
                    ruleMatched: true,
                    ruleGroupIds: [],
                    source: 'LOCAL',
                    checkedAt: expect.any(Date),
                    revision: 1,
                    evaluated: true,
                    failureKind: null,
                    meta: {},
                },
            });
            expect(prisma.monitorState.upsert).toHaveBeenCalledWith({
                where: { monitorId: 'monitor-1' },
                create: expect.objectContaining({
                    monitorId: 'monitor-1',
                    status: 'DEGRADED',
                    failCount: 1,
                    lastLatency: 30,
                }),
                update: expect.objectContaining({
                    status: 'DEGRADED',
                    failCount: 1,
                }),
            });
            expect(transition).toMatchObject({
                previousStatus: 'UP',
                status: 'DEGRADED',
                failCount: 1,
                changed: true,
            });
        });

        it('reports no change when the derived status is unchanged', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: { ...stateRow, status: 'DEGRADED', failCount: 1 },
            });
            prisma.checkLog.create.mockResolvedValue({ id: 'log-1' });
            prisma.monitorState.upsert.mockResolvedValue(stateRow);

            const recorded = await service.record('monitor-1', {
                success: false,
                latency: 12,
            });
            const transition = recorded!.transition;

            expect(transition.changed).toBe(false);
            expect(transition.status).toBe('DEGRADED');
            expect(transition.failCount).toBe(2);
        });

        it('defaults a missing state row to UNKNOWN', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: null,
            });
            prisma.checkLog.create.mockResolvedValue({ id: 'log-1' });
            prisma.monitorState.upsert.mockResolvedValue(stateRow);

            const recorded = await service.record('monitor-1', {
                success: true,
                latency: 10,
            });
            const transition = recorded!.transition;

            expect(transition.previousStatus).toBe('UNKNOWN');
            expect(transition.status).toBe('UP');
            expect(transition.changed).toBe(true);
        });

        it('throws when the monitor does not exist', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue(null);

            await expect(
                service.record('missing', { success: true, latency: 1 }),
            ).rejects.toThrow(NotFoundException);
            expect(prisma.checkLog.create).not.toHaveBeenCalled();
        });

        it('persists SSL certificate details when present', async () => {
            const { service, prisma } = createService();
            const ssl = {
                expiresAt: new Date('2026-04-05T12:00:00.000Z'),
                daysRemaining: 31,
                issuer: 'Example CA',
                subject: 'api.example.com',
            };
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: { ...stateRow, status: 'UP', failCount: 0 },
            });
            prisma.checkLog.create.mockResolvedValue({ id: 'log-1' });
            prisma.monitorState.upsert.mockResolvedValue({
                ...stateRow,
                sslExpiresAt: ssl.expiresAt,
                sslDaysRemaining: ssl.daysRemaining,
                sslIssuer: ssl.issuer,
                sslSubject: ssl.subject,
            });

            await service.record('monitor-1', {
                success: true,
                latency: 30,
                ssl,
            });

            expect(prisma.monitorState.upsert).toHaveBeenCalledWith({
                where: { monitorId: 'monitor-1' },
                create: expect.objectContaining({
                    sslExpiresAt: ssl.expiresAt,
                    sslDaysRemaining: 31,
                    sslIssuer: 'Example CA',
                    sslSubject: 'api.example.com',
                }),
                update: expect.objectContaining({
                    sslExpiresAt: ssl.expiresAt,
                    sslDaysRemaining: 31,
                    sslIssuer: 'Example CA',
                    sslSubject: 'api.example.com',
                }),
            });
        });

        it('keeps the local schedule untouched for a probe-driven outcome', async () => {
            const { service, prisma } = createService();
            const checkedAt = new Date('2026-03-05T12:05:00.000Z');
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: { ...stateRow, status: 'UP', failCount: 0 },
            });
            prisma.checkLog.create.mockResolvedValue({ id: 'log-1' });
            prisma.monitorState.upsert.mockResolvedValue(stateRow);

            await service.record('monitor-1', {
                success: true,
                latency: 30,
                source: CheckSource.PROBE,
                checkedAt,
                localSuccess: false,
                rescuedByProbe: true,
            });

            expect(prisma.checkLog.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    success: true,
                    localSuccess: false,
                    rescuedByProbe: true,
                    source: CheckSource.PROBE,
                }),
            });
            expect(prisma.monitorState.upsert).toHaveBeenCalledWith({
                where: { monitorId: 'monitor-1' },
                create: expect.objectContaining({
                    lastCheckAt: expect.any(Date),
                }),
                update: expect.objectContaining({
                    lastCheckAt: expect.any(Date),
                    lastLocalCheckAt: undefined,
                }),
            });
        });

        it('advances the local schedule on a local check', async () => {
            const { service, prisma } = createService();
            const checkedAt = new Date('2026-03-05T12:05:00.000Z');
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: { ...stateRow, status: 'UP', failCount: 0 },
            });
            prisma.checkLog.create.mockResolvedValue({ id: 'log-1' });
            prisma.monitorState.upsert.mockResolvedValue(stateRow);

            await service.record('monitor-1', {
                success: true,
                latency: 30,
                checkedAt,
            });

            expect(prisma.monitorState.upsert).toHaveBeenCalledWith({
                where: { monitorId: 'monitor-1' },
                create: expect.objectContaining({
                    lastLocalCheckAt: checkedAt,
                }),
                update: expect.objectContaining({
                    lastLocalCheckAt: checkedAt,
                }),
            });
            expect(prisma.checkLog.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    localSuccess: true,
                    rescuedByProbe: false,
                    source: CheckSource.LOCAL,
                }),
            });
        });
    });

    describe('getSummary', () => {
        it('combines the state row with the trailing 24h uptime window', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: { ...stateRow, status: 'UP', lastLatency: 120 },
            });
            prisma.checkLog.count
                .mockResolvedValueOnce(100)
                .mockResolvedValueOnce(99);
            prisma.checkLog.aggregate.mockResolvedValue({
                _avg: { latency: 127.6 },
            });

            const summary = await service.getSummary('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(prisma.monitor.findFirst).toHaveBeenCalledWith({
                where: {
                    id: 'monitor-1',
                    projectId: 'project-1',
                    deletedAt: null,
                },
                include: { state: true },
            });
            expect(summary.status).toBe('UP');
            expect(summary.uptimePercent).toBe(99);
            expect(summary.avgLatency).toBe(128);
            expect(summary.sslExpiresAt).toBeNull();
            expect(prisma.checkLog.count).toHaveBeenCalledWith({
                where: expect.objectContaining({ evaluated: true }),
            });
        });

        it('returns null metrics when there is no check history', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: null,
            });
            prisma.checkLog.count.mockResolvedValue(0);
            prisma.checkLog.aggregate.mockResolvedValue({
                _avg: { latency: null },
            });

            const summary = await service.getSummary('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(summary.status).toBe('UNKNOWN');
            expect(summary.uptimePercent).toBeNull();
            expect(summary.avgLatency).toBeNull();
        });

        it('throws when the monitor is not in the organization', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue(null);

            await expect(
                service.getSummary('project-1', 'monitor-1', {
                    type: 'USER',
                    userId: 'user-1',
                }),
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('markNotified', () => {
        it('does not let stale alert acknowledgements update a new definition', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue(null);
            await service.markNotified('monitor-1', MonitorStatus.DOWN, 1);
            await service.markSslNotified('monitor-1', new Date(), 1);
            expect(
                await service.claimAvailabilityAlert(
                    'monitor-1',
                    1,
                    true,
                    new Date(),
                ),
            ).toBeNull();
            expect(prisma.monitorState.update).not.toHaveBeenCalled();
            expect(prisma.monitorState.updateMany).not.toHaveBeenCalled();
        });

        it('claims availability state only for the current revision and observation', async () => {
            const { service, prisma } = createService();
            const checkedAt = new Date();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                revision: 2,
                state: {
                    ...stateRow,
                    lastCheckAt: checkedAt,
                    availabilityAlertActive: false,
                },
            });
            expect(
                await service.claimAvailabilityAlert(
                    'monitor-1',
                    2,
                    true,
                    checkedAt,
                ),
            ).toEqual(expect.any(String));
            expect(prisma.monitor.findFirst).toHaveBeenCalledWith({
                where: {
                    id: 'monitor-1',
                    revision: 2,
                    enabled: true,
                    deletedAt: null,
                },
                include: { state: true },
            });
            expect(prisma.monitorState.updateMany).toHaveBeenCalledWith({
                where: {
                    monitorId: 'monitor-1',
                },
                data: {
                    availabilityAlertActive: true,
                    availabilityAlertPendingId: expect.any(String),
                    lastAvailabilityAlertAt: expect.any(Date),
                },
            });
        });

        it('recovers the durable alert claim after enqueue failure or process restart', async () => {
            const { service, prisma } = createService();
            const checkedAt = new Date();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: {
                    ...stateRow,
                    lastCheckAt: checkedAt,
                    availabilityAlertActive: true,
                    availabilityAlertPendingId: 'persisted-pending-event',
                },
            });
            expect(
                await service.claimAvailabilityAlert(
                    'monitor-1',
                    1,
                    true,
                    checkedAt,
                ),
            ).toBe('persisted-pending-event');
            expect(prisma.monitorState.updateMany).not.toHaveBeenCalled();
            await service.completeAvailabilityAlert(
                'monitor-1',
                1,
                true,
                'persisted-pending-event',
            );
            expect(prisma.monitorState.updateMany).toHaveBeenCalledWith({
                where: {
                    monitorId: 'monitor-1',
                    availabilityAlertActive: true,
                    availabilityAlertPendingId: 'persisted-pending-event',
                },
                data: { availabilityAlertPendingId: null },
            });
        });

        it('stores the last notified status on the state row', async () => {
            const { service, prisma } = createService();
            prisma.monitorState.update.mockResolvedValue(stateRow);

            await service.markNotified('monitor-1', MonitorStatus.DOWN);

            expect(prisma.monitorState.update).toHaveBeenCalledWith({
                where: { monitorId: 'monitor-1' },
                data: { lastNotifiedStatus: 'DOWN' },
            });
        });

        it('stores when an SSL alert was delivered', async () => {
            const { service, prisma } = createService();
            const notifiedAt = new Date('2026-03-05T12:00:00.000Z');
            prisma.monitorState.update.mockResolvedValue(stateRow);

            await service.markSslNotified('monitor-1', notifiedAt);

            expect(prisma.monitorState.update).toHaveBeenCalledWith({
                where: { monitorId: 'monitor-1' },
                data: { sslLastNotifiedAt: notifiedAt },
            });
        });
    });
});
