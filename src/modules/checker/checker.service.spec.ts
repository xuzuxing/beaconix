import { mockProjectAccess } from '../../common/authorization/access-test.fixture';
import { NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
    buildRoundId,
    CheckerService,
    probeReportDedupWindowMs,
    probeResultWindowMs,
    roundAttributionWindowMs,
} from './checker.service';
import type { StateService } from '../state/state.service';
import type { NotifierService } from '../notifier/notifier.service';
import { MONITOR_CHECK_JOB, MONITOR_SETTLE_JOB } from './checker.queue';
import type { MonitorCheckJobData } from './checker.queue';
import { CheckerRegistry } from './checker.registry';

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
    config: {},
    configVersion: 1,
    revision: 1,
    configRevision: 1,
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
    deletedAt: null,
};

const stateRow = {
    monitorId: 'monitor-1',
    status: 'UP',
    failCount: 0,
    lastCheckAt: new Date('2026-03-05T12:00:00.000Z'),
    lastError: null,
    lastLatency: 12,
    lastNotifiedStatus: null,
    sslExpiresAt: null,
    sslDaysRemaining: null,
    sslIssuer: null,
    sslSubject: null,
    sslLastNotifiedAt: null,
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
};

const checkResult = {
    success: true,
    latency: 12,
    error: null,
    checkedAt: new Date('2026-03-05T12:00:00.000Z'),
};

type Round = Record<string, unknown> & {
    id: string;
    monitorId: string;
    roundId: string | null;
    appliedAt: Date | null;
    checkedAt: Date;
};

function probeSample(
    probeId: string,
    success: boolean,
    checkedAt = new Date('2026-03-05T11:59:30.000Z'),
) {
    return {
        id: `sample-${probeId}`,
        probeId,
        success,
        checkedAt,
        receivedAt: checkedAt,
    };
}

function createService() {
    const rounds = new Map<string, Round>();
    const prisma = {
        auditLog: { create: jest.fn().mockResolvedValue({}) },
        monitor: { findFirst: jest.fn(), findMany: jest.fn() },
        checkLog: {
            create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
                const row = {
                    observationId: null,
                    evaluated: true,
                    failureKind: null,
                    localSuccess: null,
                    localServiceVerdict: null,
                    serviceVerdict: null,
                    sslVerdict: null,
                    statusCode: null,
                    ruleMatched: false,
                    ruleGroupIds: [],
                    meta: {},
                    appliedAt: null,
                    ...data,
                } as unknown as Round;
                row.id = `log-${rounds.size + 1}`;
                rounds.set(row.id, row);
                return row;
            }),
            findUnique: jest.fn(
                ({
                    where,
                }: {
                    where: {
                        monitorId_roundId: {
                            monitorId: string;
                            roundId: string;
                        };
                    };
                }) => {
                    const key = where.monitorId_roundId;
                    return (
                        [...rounds.values()].find(
                            (row) =>
                                row.monitorId === key.monitorId &&
                                row.roundId === key.roundId,
                        ) ?? null
                    );
                },
            ),
            findFirst: jest.fn(({ where }: { where: Record<string, any> }) => {
                const rows = [...rounds.values()]
                    .filter((row) => row.monitorId === where.monitorId)
                    .sort(
                        (a, b) => b.checkedAt.getTime() - a.checkedAt.getTime(),
                    );
                if (where.roundId && where.appliedAt === null) {
                    return (
                        rows.find(
                            (row) => row.roundId && row.appliedAt === null,
                        ) ?? null
                    );
                }
                if (where.checkedAt?.lt) {
                    return (
                        rows.find(
                            (row) =>
                                row.roundId &&
                                row.checkedAt < where.checkedAt.lt,
                        ) ?? null
                    );
                }
                return null;
            }),
            findMany: jest.fn(
                ({ where }: { where?: Record<string, any> } = {}) => {
                    if (where?.appliedAt === null) {
                        return [...rounds.values()].filter(
                            (row) =>
                                row.monitorId === where.monitorId &&
                                row.roundId &&
                                row.appliedAt === null,
                        );
                    }
                    return [];
                },
            ),
            update: jest.fn(
                ({
                    where,
                    data,
                }: {
                    where: { id: string };
                    data: Record<string, unknown>;
                }) => {
                    const row = rounds.get(where.id);
                    if (row) Object.assign(row, data);
                    return row;
                },
            ),
            updateMany: jest.fn(() => ({ count: 0 })),
            count: jest.fn().mockResolvedValue(0),
        },
        probe: { findMany: jest.fn().mockResolvedValue([]) },
        probeResult: { findMany: jest.fn().mockResolvedValue([]) },
        probeExecution: { create: jest.fn().mockResolvedValue({}) },
        monitorState: {
            upsert: jest.fn().mockResolvedValue(stateRow),
            update: jest.fn(),
        },
        $queryRaw: jest.fn().mockResolvedValue([]),
        $transaction: jest.fn((callback: (tx: unknown) => Promise<unknown>) =>
            callback(prisma),
        ),
    };
    const settleResult = {
        monitor: monitorRow,
        state: stateRow,
        transition: {
            previousStatus: 'UNKNOWN',
            previousFailCount: 0,
            status: 'UP',
            failCount: 0,
            changed: true,
        },
        deliveries: 0,
    };
    const stateService = {
        claimAvailabilityAlert: jest.fn().mockResolvedValue('pending-1'),
        completeAvailabilityAlert: jest.fn(),
        record: jest.fn(),
        // Mirrors the real settlement: the batch row is marked applied, and a
        // second attempt on the same row loses the race.
        settle: jest.fn(
            (
                monitorId: string,
                roundId: string,
                verdict: Record<string, unknown>,
            ): Promise<typeof settleResult | null> => {
                const round = [...rounds.values()].find(
                    (row) =>
                        row.monitorId === monitorId && row.roundId === roundId,
                );
                if (!round || round.appliedAt) return Promise.resolve(null);
                round.appliedAt = new Date();
                round.settlement = verdict;
                return Promise.resolve(settleResult);
            },
        ),
    };
    const notifierService = {
        notifyTransition: jest
            .fn()
            .mockResolvedValue({ skipped: false, sent: 1, failed: 0 }),
        notifyAvailabilityAlert: jest
            .fn()
            .mockResolvedValue({ skipped: false, sent: 1, failed: 0 }),
        notifyAvailabilityRecovery: jest
            .fn()
            .mockResolvedValue({ skipped: false, sent: 1, failed: 0 }),
    };
    const httpChecker = { check: jest.fn().mockResolvedValue(checkResult) };
    const tcpChecker = { check: jest.fn().mockResolvedValue(checkResult) };
    const dnsChecker = {
        type: 'DNS',
        run: jest.fn().mockResolvedValue(checkResult),
    };
    const pingChecker = {
        type: 'PING',
        run: jest.fn().mockResolvedValue(checkResult),
    };
    const registry = new CheckerRegistry(
        {
            type: 'HTTP',
            run: (m: typeof monitorRow) =>
                httpChecker.check(m.target, m.timeout, m.expectedStatus, {
                    checkSsl: m.checkSsl,
                    sslExpiryThreshold: m.sslExpiryThreshold,
                }),
        } as never,
        {
            type: 'TCP',
            run: (m: typeof monitorRow) =>
                tcpChecker.check(m.target, m.timeout),
        } as never,
        dnsChecker as never,
        pingChecker as never,
        ...([
            'MYSQL',
            'POSTGRESQL',
            'REDIS',
            'MONGODB',
            'DOCKER',
            'GRPC',
            'WEBSOCKET',
        ].map((type) => ({
            type,
            run: jest.fn().mockResolvedValue(checkResult),
        })) as [never, never, never, never, never, never, never]),
        { open: (monitor: typeof monitorRow) => monitor.config } as never,
    );
    const quotaService = {
        assertMonitorTypeAllowed: jest.fn().mockResolvedValue(undefined),
        assertIntervalAllowed: jest.fn().mockResolvedValue(undefined),
        monitorEligibility: jest
            .fn()
            .mockResolvedValue({ eligible: true, reason: null }),
        getMonitorPolicy: jest.fn().mockResolvedValue({
            allowedMonitorTypes: ['HTTP', 'TCP', 'PING', 'DNS'],
            minInterval: 10,
        }),
    };
    const systemProbeScheduler = {
        getAssignedProbes: jest.fn().mockResolvedValue([]),
    };

    const ruleEvaluator = {
        evaluate: jest.fn().mockReturnValue(false),
        explain: jest.fn().mockReturnValue([]),
    };
    const ruleGroups = {
        findBindingsForMonitor: jest.fn().mockResolvedValue([]),
    };
    const queue = { add: jest.fn().mockResolvedValue({}) };

    const access = mockProjectAccess(prisma);
    const service = new CheckerService(
        prisma,
        stateService as unknown as StateService,
        notifierService as unknown as NotifierService,
        registry,
        quotaService as never,
        systemProbeScheduler as never,
        ruleEvaluator as never,
        ruleGroups as never,
        access,
        queue as unknown as Queue<MonitorCheckJobData>,
    );

    return {
        service,
        prisma,
        stateService,
        notifierService,
        httpChecker,
        tcpChecker,
        systemProbeScheduler,
        ruleEvaluator,
        ruleGroups,
        dnsChecker,
        pingChecker,
        quotaService,
        access,
        queue,
        rounds,
        settleResult,
    };
}

/** Seeds a pending batch row without running a local check. */
function seedRound(
    rounds: Map<string, Round>,
    overrides: Partial<Round> = {},
): Round {
    const row = {
        id: `log-seed-${rounds.size + 1}`,
        monitorId: 'monitor-1',
        roundId: 'monitor-1:1700000000000',
        appliedAt: null,
        checkedAt: new Date('2026-03-05T12:00:00.000Z'),
        localSuccess: true,
        success: true,
        latency: 12,
        error: null,
        statusCode: 200,
        failureKind: null,
        localServiceVerdict: 'SUCCESS',
        serviceVerdict: 'SUCCESS',
        sslVerdict: null,
        ruleMatched: false,
        ruleGroupIds: [],
        meta: { aggregation: { protected: false, protectedReason: null } },
        configRevision: 1,
        revision: 1,
        evaluated: true,
        ...overrides,
    } as unknown as Round;
    rounds.set(row.id, row);
    return row;
}

function bindProbes(
    prisma: ReturnType<typeof createService>['prisma'],
    count: number,
) {
    const probes = Array.from({ length: count }, (_, index) => ({
        id: `probe-${index + 1}`,
    }));
    prisma.probe.findMany.mockResolvedValue(probes);
    return probes;
}

describe('CheckerService', () => {
    describe('batch anchored by the local check', () => {
        it('settles as soon as every bound probe reported', async () => {
            const { service, prisma, stateService, rounds } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            bindProbes(prisma, 2);
            prisma.probeResult.findMany.mockResolvedValue([
                probeSample('probe-1', true),
                probeSample('probe-2', true),
            ]);

            const execution = await service.checkMonitorForProject(
                'project-1',
                'monitor-1',
                { type: 'USER', userId: 'user-1' },
            );

            expect(execution.applied).toBe(true);
            expect(stateService.settle).toHaveBeenCalledTimes(1);
            expect(stateService.record).not.toHaveBeenCalled();
            expect(stateService.settle.mock.calls[0][2]).toMatchObject({
                success: true,
                rescuedByProbe: false,
                aggregation: {
                    effectiveProbeCount: 2,
                    sampleCount: 2,
                    successCount: 2,
                    decision: 'CONFIRMED_SUCCESS',
                },
            });
            expect([...rounds.values()][0].roundId).toMatch(/^monitor-1:\d+$/);
        });

        it('stays pending until the deadline when probes are missing', async () => {
            const { service, prisma, stateService, queue } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            bindProbes(prisma, 3);
            prisma.probeResult.findMany.mockResolvedValue([
                probeSample('probe-1', true),
            ]);

            const execution = await service.checkMonitorForProject(
                'project-1',
                'monitor-1',
                { type: 'USER', userId: 'user-1' },
            );

            expect(execution.applied).toBe(false);
            expect(stateService.settle).not.toHaveBeenCalled();
            expect(queue.add).toHaveBeenCalledWith(
                MONITOR_SETTLE_JOB,
                expect.objectContaining({ monitorId: 'monitor-1' }),
                expect.objectContaining({
                    delay: expect.any(Number),
                    jobId: expect.stringMatching(/^monitor-check-settle-/),
                }),
            );
        });

        it('settles a protected batch immediately without sampling probes', async () => {
            const { service, prisma, stateService, httpChecker } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            bindProbes(prisma, 2);
            httpChecker.check.mockResolvedValue({
                ...checkResult,
                success: false,
                failureKind: 'ASSERTION',
                error: 'HTTP keyword assertion failed',
            });

            const execution = await service.checkMonitorForProject(
                'project-1',
                'monitor-1',
                { type: 'USER', userId: 'user-1' },
            );

            expect(prisma.probeResult.findMany).not.toHaveBeenCalled();
            expect(prisma.probe.findMany).not.toHaveBeenCalled();
            expect(stateService.settle).toHaveBeenCalledTimes(1);
            expect(stateService.settle.mock.calls[0][2]).toMatchObject({
                success: false,
                failureKind: 'ASSERTION',
                aggregation: {
                    protected: true,
                    protectedReason: 'ASSERTION',
                    decision: 'FALLBACK_LOCAL',
                },
            });
            expect(execution.applied).toBe(true);
        });

        it('keeps the local verdict when no tenant probe is bound', async () => {
            const { service, prisma, stateService } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            prisma.probe.findMany.mockResolvedValue([]);

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(prisma.probe.findMany).toHaveBeenCalledTimes(1);
            expect(prisma.probeResult.findMany).not.toHaveBeenCalled();
            expect(stateService.settle.mock.calls[0][2]).toMatchObject({
                success: true,
                aggregation: {
                    effectiveProbeCount: 0,
                    decision: 'FALLBACK_LOCAL',
                },
            });
        });

        it('keeps a failing local verdict UP when no tenant probe is bound and a system probe succeeded', async () => {
            const {
                service,
                prisma,
                stateService,
                systemProbeScheduler,
                httpChecker,
            } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            prisma.probe.findMany.mockResolvedValue([]);
            systemProbeScheduler.getAssignedProbes.mockResolvedValue(['sys-1']);
            prisma.probeResult.findMany.mockResolvedValue([
                probeSample('sys-1', true),
            ]);
            httpChecker.check.mockResolvedValue({
                ...checkResult,
                success: false,
                error: 'Request timed out',
                failureKind: 'TRANSPORT',
            });

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(stateService.settle.mock.calls[0][2]).toMatchObject({
                success: true,
                rescuedByProbe: true,
                serviceVerdict: 'SUCCESS',
                aggregation: { effectiveProbeCount: 0, decision: 'RESCUED' },
            });
        });

        it('falls back to the local verdict while bound probes never reported', async () => {
            const { service, prisma, stateService, httpChecker, rounds } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            bindProbes(prisma, 2);
            prisma.probeResult.findMany.mockResolvedValue([]);
            httpChecker.check.mockResolvedValue({
                ...checkResult,
                success: false,
                error: 'Request timed out',
                failureKind: 'TRANSPORT',
            });

            const execution = await service.checkMonitorForProject(
                'project-1',
                'monitor-1',
                { type: 'USER', userId: 'user-1' },
            );

            // Nobody reported: the batch waits for its deadline instead of
            // reading the missing probes as failures.
            expect(execution.applied).toBe(false);
            expect(stateService.settle).not.toHaveBeenCalled();

            const forced = await service.settleRound(
                'monitor-1',
                [...rounds.values()][0].roundId!,
                { force: true },
            );

            expect(forced.outcome).toBe('SETTLED');
            expect(stateService.settle.mock.calls[0][2]).toMatchObject({
                success: false,
                failureKind: 'TRANSPORT',
                aggregation: {
                    effectiveProbeCount: 2,
                    sampleCount: 0,
                    decision: 'FALLBACK_LOCAL',
                },
            });
        });
    });

    describe('ratio verdict', () => {
        it.each([
            { probes: 3, ratio: 100, successes: 3, passed: true },
            { probes: 3, ratio: 100, successes: 2, passed: false },
            { probes: 5, ratio: 60, successes: 3, passed: true },
            { probes: 5, ratio: 60, successes: 2, passed: false },
            { probes: 5, ratio: 1, successes: 1, passed: true },
            { probes: 5, ratio: 1, successes: 0, passed: false },
        ])(
            'votes $successes/$probes against $ratio%',
            async ({ probes, ratio, successes, passed }) => {
                const { service, prisma, stateService, rounds } =
                    createService();
                prisma.monitor.findFirst.mockResolvedValue({
                    ...monitorRow,
                    probeSuccessRatio: ratio,
                });
                const bound = bindProbes(prisma, probes);
                prisma.probeResult.findMany.mockResolvedValue(
                    bound.map((probe, index) =>
                        probeSample(probe.id, index < successes),
                    ),
                );
                seedRound(rounds);

                const settlement = await service.settleRound(
                    'monitor-1',
                    'monitor-1:1700000000000',
                    { force: true },
                );

                expect(settlement.outcome).toBe('SETTLED');
                expect(stateService.settle.mock.calls[0][2]).toMatchObject({
                    success: passed,
                    aggregation: {
                        effectiveProbeCount: probes,
                        successCount: successes,
                        threshold: ratio,
                    },
                });
            },
        );

        it('counts a missing probe as a failure instead of shrinking the denominator', async () => {
            const { service, prisma, stateService, rounds } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                probeSuccessRatio: 100,
            });
            bindProbes(prisma, 3);
            prisma.probeResult.findMany.mockResolvedValue([
                probeSample('probe-1', true),
                probeSample('probe-2', true),
            ]);
            seedRound(rounds);

            await service.settleRound('monitor-1', 'monitor-1:1700000000000', {
                force: true,
            });

            expect(stateService.settle.mock.calls[0][2]).toMatchObject({
                success: false,
                aggregation: {
                    effectiveProbeCount: 3,
                    sampleCount: 2,
                    successCount: 2,
                },
            });
        });

        it('rescues a failing local check with the probe majority', async () => {
            const { service, prisma, stateService, rounds } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                probeSuccessRatio: 60,
            });
            bindProbes(prisma, 3);
            prisma.probeResult.findMany.mockResolvedValue([
                probeSample('probe-1', true),
                probeSample('probe-2', true),
                probeSample('probe-3', false),
            ]);
            seedRound(rounds, {
                localSuccess: false,
                success: false,
                failureKind: 'TRANSPORT',
                error: 'Request timed out',
                localServiceVerdict: 'FAILURE',
                serviceVerdict: 'FAILURE',
            });

            await service.settleRound('monitor-1', 'monitor-1:1700000000000', {
                force: true,
            });

            expect(stateService.settle.mock.calls[0][2]).toMatchObject({
                success: true,
                rescuedByProbe: true,
                failureKind: null,
                serviceVerdict: 'SUCCESS',
                localServiceVerdict: 'FAILURE',
                aggregation: { decision: 'RESCUED' },
            });
        });

        it('overturns a successful local check when the probes vote it down', async () => {
            const { service, prisma, stateService, rounds } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                probeSuccessRatio: 100,
            });
            bindProbes(prisma, 3);
            prisma.probeResult.findMany.mockResolvedValue([
                probeSample('probe-1', true),
                probeSample('probe-2', false),
                probeSample('probe-3', false),
            ]);
            seedRound(rounds);

            await service.settleRound('monitor-1', 'monitor-1:1700000000000', {
                force: true,
            });

            expect(stateService.settle.mock.calls[0][2]).toMatchObject({
                success: false,
                localSuccess: true,
                rescuedByProbe: false,
                failureKind: 'AGGREGATE',
                serviceVerdict: 'FAILURE',
                error: expect.stringContaining('1/3'),
                aggregation: { decision: 'OVERTURNED' },
            });
        });

        it('keeps one vote per probe, using its newest observation', async () => {
            const { service, prisma, stateService, rounds } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                probeSuccessRatio: 100,
            });
            bindProbes(prisma, 2);
            prisma.probeResult.findMany.mockResolvedValue([
                probeSample('probe-1', false),
                probeSample('probe-1', true),
                probeSample('probe-2', true),
            ]);
            seedRound(rounds);

            await service.settleRound('monitor-1', 'monitor-1:1700000000000', {
                force: true,
            });

            // The query returns rows newest-first, so probe-1's first sample wins.
            expect(stateService.settle.mock.calls[0][2]).toMatchObject({
                success: false,
                aggregation: { sampleCount: 2, successCount: 1 },
            });
        });

        it('does not count a system probe as a primary vote', async () => {
            const { service, prisma, stateService, rounds } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                probeSuccessRatio: 100,
            });
            bindProbes(prisma, 1);
            prisma.probeResult.findMany.mockResolvedValue([
                probeSample('probe-1', false),
            ]);
            seedRound(rounds);

            await service.settleRound('monitor-1', 'monitor-1:1700000000000', {
                force: true,
            });

            expect(stateService.settle.mock.calls[0][2]).toMatchObject({
                success: false,
                aggregation: { effectiveProbeCount: 1, successCount: 0 },
            });
        });
    });

    describe('batch lifecycle', () => {
        it('returns NOT_FOUND without a local row', async () => {
            const { service } = createService();

            const settlement = await service.settleRound(
                'monitor-1',
                'monitor-1:1700000000000',
            );

            expect(settlement).toEqual({
                outcome: 'NOT_FOUND',
                execution: null,
            });
        });

        it('treats an already settled batch as a duplicate', async () => {
            const { service, prisma, rounds } = createService();
            seedRound(rounds, { appliedAt: new Date() });

            const settlement = await service.settleRound(
                'monitor-1',
                'monitor-1:1700000000000',
                { force: true },
            );

            expect(settlement.outcome).toBe('DUPLICATE');
            expect(prisma.probe.findMany).not.toHaveBeenCalled();
        });

        it('settles once: a second forced call is a duplicate', async () => {
            const { service, prisma, stateService, rounds } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            bindProbes(prisma, 1);
            prisma.probeResult.findMany.mockResolvedValue([
                probeSample('probe-1', true),
            ]);
            seedRound(rounds);

            const first = await service.settleRound(
                'monitor-1',
                'monitor-1:1700000000000',
                { force: true },
            );
            const second = await service.settleRound(
                'monitor-1',
                'monitor-1:1700000000000',
                { force: true },
            );

            expect(first.outcome).toBe('SETTLED');
            expect(second.outcome).toBe('DUPLICATE');
            expect(stateService.settle).toHaveBeenCalledTimes(1);
        });

        it('discards a batch whose definition changed while it was open', async () => {
            const { service, prisma, rounds } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                configRevision: 2,
            });
            seedRound(rounds);

            const settlement = await service.settleRound(
                'monitor-1',
                'monitor-1:1700000000000',
                { force: true },
            );

            expect(settlement.outcome).toBe('DUPLICATE');
        });

        it('reports a settlement conflict from the state writer as a duplicate', async () => {
            const { service, prisma, stateService, rounds } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            prisma.probe.findMany.mockResolvedValue([]);
            stateService.settle.mockResolvedValue(null);
            seedRound(rounds);

            const settlement = await service.settleRound(
                'monitor-1',
                'monitor-1:1700000000000',
                { force: true },
            );

            expect(settlement.outcome).toBe('DUPLICATE');
        });

        it('settles the previous open batch before anchoring a new one', async () => {
            const { service, prisma, stateService, rounds } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            prisma.probe.findMany.mockResolvedValue([]);
            seedRound(rounds, {
                roundId: 'monitor-1:1699999999000',
                checkedAt: new Date('2026-03-05T11:59:00.000Z'),
            });

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            // The stale round is settled by its deadline, then the new one settles.
            const sunkRoundIds = stateService.settle.mock.calls.map(
                (call) => call[1],
            );
            expect(sunkRoundIds).toContain('monitor-1:1699999999000');
            expect(sunkRoundIds).toHaveLength(2);
        });
    });

    describe('probe report ingestion', () => {
        it('settles the open batch instead of appending a row', async () => {
            const { service, prisma, stateService, rounds } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            bindProbes(prisma, 1);
            prisma.probeResult.findMany.mockResolvedValue([
                probeSample('probe-1', true),
            ]);
            seedRound(rounds);

            const execution = await service.ingestProbeReportForMonitor(
                'monitor-1',
                {
                    target: monitorRow.target,
                    success: true,
                    latency: 1,
                },
            );

            expect(execution).toMatchObject({ applied: true });
            expect(prisma.checkLog.create).not.toHaveBeenCalled();
            expect(stateService.settle).toHaveBeenCalledTimes(1);
        });

        it('ignores a report when no batch is open', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);

            expect(
                await service.ingestProbeReportForMonitor('monitor-1', {
                    target: monitorRow.target,
                    success: true,
                    latency: 1,
                }),
            ).toBeNull();
        });

        it('ignores a report for an assertion batch', async () => {
            const { service, prisma, rounds } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            seedRound(rounds, { failureKind: 'ASSERTION' });

            expect(
                await service.ingestProbeReportForMonitor('monitor-1', {
                    target: monitorRow.target,
                    success: true,
                    latency: 1,
                }),
            ).toBeNull();
            expect(prisma.probe.findMany).not.toHaveBeenCalled();
        });

        it('keeps non-legacy protocols out of probe aggregation', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                config: { keyword: 'healthy' },
            });

            expect(
                await service.ingestProbeReportForMonitor('monitor-1', {
                    target: monitorRow.target,
                    success: true,
                    latency: 1,
                }),
            ).toBeNull();
        });

        it('returns null when no monitor owns the target', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findMany.mockResolvedValue([
                monitorRow,
                { ...monitorRow, id: 'monitor-2' },
            ]);

            expect(
                await service.ingestProbeReport('org-1', {
                    target: monitorRow.target,
                    success: true,
                    latency: 1,
                }),
            ).toBeNull();
        });
    });

    describe('execution guards', () => {
        it('stops queued jobs and manual checks when entitlement is revoked', async () => {
            const { service, prisma, httpChecker, quotaService, stateService } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            quotaService.monitorEligibility.mockResolvedValue({
                eligible: false,
                reason: 'MONITOR_TYPE_NOT_ALLOWED',
            });
            expect(await service.executeMonitor('monitor-1')).toBeNull();
            quotaService.assertMonitorTypeAllowed.mockRejectedValue(
                new Error('not allowed'),
            );
            await expect(
                service.checkMonitorForProject('project-1', 'monitor-1', {
                    type: 'USER',
                    userId: 'user-1',
                }),
            ).rejects.toThrow('not allowed');
            expect(httpChecker.check).not.toHaveBeenCalled();
            expect(stateService.settle).not.toHaveBeenCalled();
        });

        it('does not record or alert after an entitlement expires during the network check', async () => {
            const { service, prisma, stateService, quotaService } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            quotaService.monitorEligibility
                .mockResolvedValueOnce({ eligible: true, reason: null })
                .mockResolvedValueOnce({
                    eligible: false,
                    reason: 'MONITOR_TYPE_NOT_ALLOWED',
                });

            const execution = await service.executeMonitor('monitor-1');

            expect(execution).toMatchObject({
                applied: false,
                evaluated: false,
                failureKind: 'POLICY',
            });
            expect(stateService.settle).not.toHaveBeenCalled();
            expect(prisma.checkLog.create).not.toHaveBeenCalled();
        });

        it('rejects manual execution while a monitor is paused', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                enabled: false,
            });

            await expect(
                service.checkMonitorForProject('project-1', 'monitor-1', {
                    type: 'USER',
                    userId: 'user-1',
                }),
            ).rejects.toThrow('Monitor is paused');
        });

        it('throws when the monitor is not in the project', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue(null);

            await expect(
                service.checkMonitorForProject('project-1', 'monitor-1', {
                    type: 'USER',
                    userId: 'user-1',
                }),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('routes DNS and PING monitors through the registry without probe aggregation', async () => {
            const { service, prisma, dnsChecker, pingChecker, stateService } =
                createService();
            for (const [type, checker] of [
                ['DNS', dnsChecker],
                ['PING', pingChecker],
            ] as const) {
                prisma.monitor.findFirst.mockResolvedValue({
                    ...monitorRow,
                    type,
                    target: 'example.com',
                    config: type === 'DNS' ? { recordType: 'A' } : {},
                });
                checker.run.mockResolvedValue({
                    ...checkResult,
                    success: false,
                    error: 'Target failed',
                    failureKind: 'ASSERTION',
                });

                await service.checkMonitorForProject('project-1', 'monitor-1', {
                    type: 'USER',
                    userId: 'user-1',
                });

                expect(checker.run).toHaveBeenCalledTimes(1);
            }
            expect(prisma.probe.findMany).not.toHaveBeenCalled();
            expect(prisma.probeResult.findMany).not.toHaveBeenCalled();
            expect(stateService.settle).toHaveBeenCalledTimes(2);
        });

        it('keeps a certificate policy failure protected from probe votes', async () => {
            const { service, prisma, httpChecker, stateService } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                checkSsl: true,
            });
            httpChecker.check.mockResolvedValue({
                ...checkResult,
                success: false,
                error: 'Certificate expired',
                sslVerdict: 'EXPIRED',
                serviceVerdict: 'SUCCESS',
                ssl: {
                    expiresAt: new Date('2026-03-01T00:00:00.000Z'),
                    daysRemaining: -4,
                    issuer: "Let's Encrypt",
                    subject: 'api.example.com',
                },
            });

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(prisma.probeResult.findMany).not.toHaveBeenCalled();
            expect(stateService.settle.mock.calls[0][2]).toMatchObject({
                success: false,
                aggregation: { protected: true, protectedReason: 'SSL' },
                ssl: expect.objectContaining({ daysRemaining: -4 }),
            });
        });
    });

    describe('enqueueDueChecks', () => {
        it('enqueues one check job per monitor whose interval elapsed', async () => {
            const { service, prisma, queue } = createService();
            prisma.monitor.findMany.mockResolvedValue([
                { ...monitorRow, state: { lastLocalCheckAt: null } },
                {
                    ...monitorRow,
                    id: 'monitor-2',
                    state: { lastLocalCheckAt: new Date() },
                },
            ]);

            await expect(
                service.enqueueDueChecks(
                    queue as unknown as Queue<MonitorCheckJobData>,
                ),
            ).resolves.toEqual({ due: 1, enqueued: 1 });
            expect(queue.add).toHaveBeenCalledWith(
                MONITOR_CHECK_JOB,
                { monitorId: 'monitor-1' },
                expect.objectContaining({
                    deduplication: { id: 'monitor-check:monitor-1' },
                }),
            );
        });

        it('keeps enqueuing the remaining monitors when one add fails', async () => {
            const { service, prisma, queue } = createService();
            prisma.monitor.findMany.mockResolvedValue([
                { ...monitorRow, state: { lastLocalCheckAt: null } },
                {
                    ...monitorRow,
                    id: 'monitor-2',
                    state: { lastLocalCheckAt: null },
                },
            ]);
            queue.add
                .mockRejectedValueOnce(new Error('redis down'))
                .mockResolvedValueOnce({});

            await expect(
                service.enqueueDueChecks(
                    queue as unknown as Queue<MonitorCheckJobData>,
                ),
            ).resolves.toEqual({ due: 2, enqueued: 1 });
        });
    });

    describe('executeMonitor', () => {
        it('runs a scheduled local check for the monitor', async () => {
            const { service, prisma, httpChecker, stateService } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);

            await service.executeMonitor('monitor-1');

            expect(httpChecker.check).toHaveBeenCalledTimes(1);
            expect(stateService.settle).toHaveBeenCalledTimes(1);
        });

        it('does nothing when the monitor is gone or disabled', async () => {
            const { service, prisma, httpChecker } = createService();
            prisma.monitor.findFirst.mockResolvedValue(null);

            expect(await service.executeMonitor('monitor-1')).toBeNull();
            expect(httpChecker.check).not.toHaveBeenCalled();
        });
    });

    describe('listCheckLogs', () => {
        it('paginates the check history', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({ id: 'monitor-1' });
            prisma.checkLog.findMany.mockResolvedValue([
                {
                    id: 'log-1',
                    monitorId: 'monitor-1',
                    success: true,
                    localSuccess: true,
                    latency: 12,
                    error: null,
                    ruleMatched: false,
                    ruleGroupIds: [],
                    source: 'LOCAL',
                    checkedAt: new Date('2026-03-05T12:00:00.000Z'),
                },
            ]);
            prisma.checkLog.count.mockResolvedValue(1);

            const page = await service.listCheckLogs(
                'project-1',
                'monitor-1',
                { page: 1, limit: 20 },
                { type: 'USER', userId: 'user-1' },
            );

            expect(page.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
            expect(page.data).toHaveLength(1);
        });

        it('throws when the monitor is not in the project', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue(null);

            await expect(
                service.listCheckLogs(
                    'project-1',
                    'monitor-1',
                    { page: 1, limit: 20 },
                    { type: 'USER', userId: 'user-1' },
                ),
            ).rejects.toBeInstanceOf(NotFoundException);
        });
    });

    describe('rule evaluation', () => {
        it('records the rule verdict against the aggregated verdict', async () => {
            const { service, prisma, ruleEvaluator, ruleGroups, rounds } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            prisma.probe.findMany.mockResolvedValue([]);
            ruleGroups.findBindingsForMonitor.mockResolvedValue([
                {
                    ruleGroupId: 'group-1',
                    ruleGroup: {
                        tree: { type: 'condition' },
                        fieldsUsed: ['latency'],
                    },
                },
            ]);
            ruleEvaluator.evaluate.mockReturnValue(true);

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(ruleEvaluator.evaluate).toHaveBeenCalled();
            expect(prisma.checkLog.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    ruleMatched: true,
                    ruleGroupIds: ['group-1'],
                }),
            });
            expect([...rounds.values()]).toHaveLength(1);
        });

        it('falls back to !success when the monitor has no bound rule group', async () => {
            const { service, prisma, stateService } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            prisma.probe.findMany.mockResolvedValue([]);

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(stateService.settle.mock.calls[0][2]).toMatchObject({
                ruleMatched: false,
            });
        });

        it('passes the actual HTTP status code into the rule context', async () => {
            const { service, prisma, ruleEvaluator, ruleGroups, httpChecker } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                expectedStatus: 200,
            });
            prisma.probe.findMany.mockResolvedValue([]);
            httpChecker.check.mockResolvedValue({
                ...checkResult,
                statusCode: 200,
            });
            ruleGroups.findBindingsForMonitor.mockResolvedValue([
                {
                    ruleGroupId: 'group-1',
                    ruleGroup: { tree: { type: 'condition' }, fieldsUsed: [] },
                },
            ]);

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(ruleEvaluator.evaluate).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ statusCode: 200 }),
            );
        });
    });

    describe('window helpers', () => {
        it('keeps the two minute floor for fast monitors', () => {
            expect(probeResultWindowMs(10)).toBe(2 * 60 * 1000);
        });

        it('scales with the monitor interval', () => {
            expect(probeResultWindowMs(120)).toBe(4 * 60 * 1000);
        });

        it('caps the window for slow monitors', () => {
            expect(probeResultWindowMs(3600)).toBe(15 * 60 * 1000);
        });

        it('scales the probe fold window with the interval', () => {
            expect(probeReportDedupWindowMs(120)).toBe(30 * 1000);
        });

        it('never suppresses reports for longer than the cap', () => {
            expect(probeReportDedupWindowMs(3600)).toBe(30 * 1000);
        });

        it('builds the round id from the local check start', () => {
            expect(
                buildRoundId('monitor-1', new Date('2026-03-05T12:00:00.000Z')),
            ).toBe('monitor-1:1772712000000');
        });

        it('attributes reports for one interval plus the fold window', () => {
            expect(roundAttributionWindowMs(60)).toBe(60_000 + 15_000);
        });
    });
});
