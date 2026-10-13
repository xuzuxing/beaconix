import { mockProjectAccess } from '../../common/authorization/access-test.fixture';
import { NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
    CheckerService,
    probeReportDedupWindowMs,
    probeResultWindowMs,
} from './checker.service';
import type { PrismaService } from '../../infra/database/prisma.service';
import type { StateService } from '../state/state.service';
import type { NotifierService } from '../notifier/notifier.service';
import { MONITOR_CHECK_JOB } from './checker.queue';
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
    checkSsl: false,
    sslExpiryThreshold: 30,
    enabled: true,
    config: {},
    configVersion: 1,
    revision: 1,
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

function createService() {
    const prisma = {
        auditLog: { create: jest.fn().mockResolvedValue({}) },
        monitor: { findFirst: jest.fn(), findMany: jest.fn() },
        checkLog: {
            findFirst: jest.fn(),
            findMany: jest.fn(),
            count: jest.fn(),
        },
        probeResult: { findMany: jest.fn().mockResolvedValue([]) },
        probeExecution: { create: jest.fn() },
        monitorState: { update: jest.fn() },
    };
    const stateService = {
        claimAvailabilityAlert: jest.fn().mockResolvedValue('pending-1'),
        completeAvailabilityAlert: jest.fn(),
        record: jest.fn().mockResolvedValue({
            monitor: monitorRow,
            state: stateRow,
            transition: {
                previousStatus: 'UNKNOWN',
                previousFailCount: 0,
                status: 'UP',
                failCount: 0,
                changed: true,
            },
        }),
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

    const access = mockProjectAccess(prisma);
    const service = new CheckerService(
        prisma as unknown as PrismaService,
        stateService as unknown as StateService,
        notifierService as unknown as NotifierService,
        registry,
        quotaService as never,
        systemProbeScheduler as never,
        ruleEvaluator as never,
        ruleGroups as never,
        access,
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
    };
}

describe('CheckerService', () => {
    describe('local protocol and execution isolation', () => {
        it.each(['ASSERTION', 'TIMEOUT', 'TRANSPORT'])(
            'keeps configured HTTP %s outcomes local, including new revision-one definitions',
            async (failureKind) => {
                const { service, prisma, httpChecker, stateService } =
                    createService();
                prisma.monitor.findFirst.mockResolvedValue({
                    ...monitorRow,
                    config: { keyword: 'healthy' },
                });
                const meta = {
                    protocol: 'HTTP',
                    bodyTruncated: false,
                    bodyBytes: 100,
                    bodyLimitBytes: 65536,
                    assertions: [{ kind: 'keyword', passed: false }],
                    assertionFailure: 'KEYWORD',
                };
                httpChecker.check.mockResolvedValue({
                    ...checkResult,
                    success: false,
                    error: 'HTTP keyword assertion failed',
                    failureKind,
                    meta,
                });
                await service.checkMonitorForProject('project-1', 'monitor-1', {
                    type: 'USER',
                    userId: 'user-1',
                });
                expect(prisma.probeResult.findMany).not.toHaveBeenCalled();
                expect(stateService.record).toHaveBeenCalledWith(
                    'monitor-1',
                    expect.objectContaining({
                        revision: 1,
                        success: false,
                        evaluated: true,
                        rescuedByProbe: false,
                        failureKind,
                        meta,
                        ruleMatched: true,
                    }),
                );
                expect(
                    await service.ingestProbeReportForMonitor('monitor-1', {
                        target: monitorRow.target,
                        success: true,
                        latency: 1,
                    }),
                ).toBeNull();
            },
        );

        it.each(['DNS', 'PING'])(
            'routes %s through the registry and never applies legacy probe rescue',
            async (type) => {
                const {
                    service,
                    prisma,
                    dnsChecker,
                    pingChecker,
                    stateService,
                } = createService();
                prisma.monitor.findFirst.mockResolvedValue({
                    ...monitorRow,
                    type,
                    target: 'example.com',
                    config: type === 'DNS' ? { recordType: 'A' } : {},
                });
                const checker = type === 'DNS' ? dnsChecker : pingChecker;
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
                expect(prisma.probeResult.findMany).not.toHaveBeenCalled();
                expect(stateService.record).toHaveBeenCalledWith(
                    'monitor-1',
                    expect.objectContaining({
                        success: false,
                        rescuedByProbe: false,
                    }),
                );
                expect(
                    await service.ingestProbeReportForMonitor('monitor-1', {
                        target: 'example.com',
                        success: true,
                        latency: 1,
                    }),
                ).toBeNull();
            },
        );

        it('does not rescue HTTP status assertions or revised definitions with old probe observations', async () => {
            const { service, prisma, httpChecker } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            httpChecker.check.mockResolvedValue({
                ...checkResult,
                success: false,
                failureKind: 'ASSERTION',
            });
            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });
            expect(prisma.probeResult.findMany).not.toHaveBeenCalled();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                revision: 2,
            });
            httpChecker.check.mockResolvedValue({
                ...checkResult,
                success: false,
            });
            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });
            expect(prisma.probeResult.findMany).not.toHaveBeenCalled();
        });

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
            expect(stateService.record).not.toHaveBeenCalled();
        });

        it('filters the due scan by runtime entitlement and resolves each org policy once', async () => {
            const { service, prisma, quotaService } = createService();
            prisma.monitor.findMany.mockResolvedValue([
                monitorRow,
                { ...monitorRow, id: 'monitor-2', type: 'DNS' },
            ]);
            quotaService.monitorEligibility
                .mockResolvedValueOnce({ eligible: true, reason: null })
                .mockResolvedValueOnce({
                    eligible: false,
                    reason: 'MONITOR_TYPE_NOT_ALLOWED',
                });
            expect(await service.findDueMonitors()).toHaveLength(1);
            expect(quotaService.getMonitorPolicy).toHaveBeenCalledTimes(1);
        });

        it('discards results that became stale without notifying', async () => {
            const { service, prisma, stateService, notifierService } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            stateService.record.mockResolvedValue(null);
            expect(
                await service.checkMonitorForProject('project-1', 'monitor-1', {
                    type: 'USER',
                    userId: 'user-1',
                }),
            ).toMatchObject({
                applied: false,
                evaluated: false,
                changed: false,
            });
            expect(notifierService.notifyTransition).not.toHaveBeenCalled();
            expect(prisma.probeExecution.create).not.toHaveBeenCalled();
        });

        it('does not record or alert after an entitlement expires during the network check', async () => {
            const {
                service,
                prisma,
                quotaService,
                stateService,
                notifierService,
            } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            quotaService.monitorEligibility.mockResolvedValue({
                eligible: false,
                reason: 'INTERVAL_TOO_SHORT',
            });
            const result = await service.checkMonitorForProject(
                'project-1',
                'monitor-1',
                { type: 'USER', userId: 'user-1' },
            );
            expect(result).toMatchObject({
                applied: false,
                evaluated: false,
                failureKind: 'POLICY',
            });
            expect(stateService.record).not.toHaveBeenCalled();
            expect(notifierService.notifyTransition).not.toHaveBeenCalled();
        });

        it('rejects manual execution while a monitor is paused', async () => {
            const { service, prisma, httpChecker } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                enabled: false,
            });
            await expect(
                service.checkMonitorForProject('project-1', 'monitor-1', {
                    type: 'USER',
                    userId: 'user-1',
                }),
            ).rejects.toThrow('paused');
            expect(httpChecker.check).not.toHaveBeenCalled();
        });
    });
    describe('checkMonitorForProject', () => {
        it.each([true, false])(
            'does not disclose response snippets to MEMBER (success=%s)',
            async (success) => {
                const { service, prisma, httpChecker, access } =
                    createService();
                prisma.monitor.findFirst.mockResolvedValue(monitorRow);
                httpChecker.check.mockResolvedValue({
                    ...checkResult,
                    success,
                    bodyContains: 'sensitive-marker',
                });
                (access.project as jest.Mock).mockResolvedValue({
                    effectiveRole: 'MEMBER',
                    organizationId: 'org-1',
                    projectId: 'project-1',
                });
                const response = await service.checkMonitorForProject(
                    'project-1',
                    'monitor-1',
                    { type: 'USER', userId: 'user-1' },
                );
                expect(response.success).toBe(success);
                expect(JSON.stringify(response)).not.toContain(
                    'sensitive-marker',
                );
                expect(response).not.toHaveProperty('bodyContains');
            },
        );
        it('runs an HTTP check and leaves delivery to the transactional outbox', async () => {
            const {
                service,
                prisma,
                stateService,
                notifierService,
                httpChecker,
            } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);

            const result = await service.checkMonitorForProject(
                'project-1',
                'monitor-1',
                { type: 'USER', userId: 'user-1' },
            );

            expect(prisma.monitor.findFirst).toHaveBeenCalledWith({
                where: {
                    id: 'monitor-1',
                    projectId: 'project-1',
                    organizationId: 'org-1',
                    deletedAt: null,
                },
            });
            expect(httpChecker.check).toHaveBeenCalledWith(
                'https://api.example.com/health',
                5000,
                200,
                {
                    checkSsl: false,
                    sslExpiryThreshold: 30,
                },
            );
            expect(stateService.record).toHaveBeenCalledWith('monitor-1', {
                success: true,
                latency: 12,
                error: null,
                source: 'LOCAL',
                checkedAt: checkResult.checkedAt,
                ssl: undefined,
                localSuccess: true,
                rescuedByProbe: false,
                statusCode: null,
                ruleMatched: false,
                ruleGroupIds: [],
                revision: 1,
                evaluated: true,
                failureKind: null,
                meta: undefined,
            });
            expect(notifierService.notifyTransition).not.toHaveBeenCalled();
            expect(prisma.probeExecution.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    probeId: null,
                    monitorId: 'monitor-1',
                    target: 'https://api.example.com/health',
                    trigger: 'MANUAL',
                    status: 'SUCCESS',
                    success: true,
                    latency: 12,
                    error: null,
                    requestMeta: {
                        source: 'LOCAL',
                        monitorType: 'HTTP',
                        revision: 1,
                        configVersion: 1,
                    },
                    responseMeta: {
                        previousStatus: 'UNKNOWN',
                        status: 'UP',
                        changed: true,
                        ruleGroupIds: [],
                        notified: {
                            skipped: true,
                            sent: 0,
                            failed: 0,
                        },
                    },
                    executedAt: checkResult.checkedAt,
                }),
            });
            expect(result).toMatchObject({
                monitorId: 'monitor-1',
                status: 'UP',
                changed: true,
                latency: 12,
            });
        });

        it('skips the notifier when the status did not change', async () => {
            const { service, prisma, stateService, notifierService } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            stateService.record.mockResolvedValue({
                monitor: monitorRow,
                state: stateRow,
                transition: {
                    previousStatus: 'UP',
                    previousFailCount: 0,
                    status: 'UP',
                    failCount: 0,
                    changed: false,
                },
            });

            const result = await service.checkMonitorForProject(
                'project-1',
                'monitor-1',
                { type: 'USER', userId: 'user-1' },
            );

            expect(notifierService.notifyTransition).not.toHaveBeenCalled();
            expect(result.notified).toEqual({
                skipped: true,
                sent: 0,
                failed: 0,
            });
        });

        it('uses the TCP checker for TCP monitors', async () => {
            const { service, prisma, tcpChecker, httpChecker } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                type: 'TCP',
                target: 'db.internal:5432',
            });

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(tcpChecker.check).toHaveBeenCalledWith(
                'db.internal:5432',
                5000,
            );
            expect(httpChecker.check).not.toHaveBeenCalled();
        });

        it('passes SSL probe details through to state recording', async () => {
            const { service, prisma, stateService, httpChecker } =
                createService();
            const ssl = {
                expiresAt: new Date('2026-04-05T12:00:00.000Z'),
                daysRemaining: 31,
                issuer: 'Example CA',
                subject: 'api.example.com',
            };
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                checkSsl: true,
                sslExpiryThreshold: 30,
            });
            httpChecker.check.mockResolvedValue({
                ...checkResult,
                ssl,
            });

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(httpChecker.check).toHaveBeenCalledWith(
                'https://api.example.com/health',
                5000,
                200,
                {
                    checkSsl: true,
                    sslExpiryThreshold: 30,
                },
            );
            expect(stateService.record).toHaveBeenCalledWith(
                'monitor-1',
                expect.objectContaining({ ssl }),
            );
        });

        it('keeps a local failure UP when a fresh bound probe succeeded', async () => {
            const { service, prisma, stateService, httpChecker } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            httpChecker.check.mockResolvedValue({
                success: false,
                latency: 30,
                error: 'HTTP 500',
                checkedAt: checkResult.checkedAt,
            });
            prisma.probeResult.findMany.mockResolvedValue([
                {
                    id: 'probe-result-1',
                    probeId: 'probe-1',
                    target: monitorRow.target,
                    success: true,
                    latency: 40,
                    error: null,
                    checkedAt: checkResult.checkedAt,
                },
            ]);

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(prisma.probeResult.findMany).toHaveBeenCalledWith({
                where: {
                    target: monitorRow.target,
                    monitorId: monitorRow.id,
                    configRevision: undefined,
                    checkedAt: { gte: expect.any(Date) },
                    probe: {
                        organizationId: 'org-1',
                        enabled: true,
                        status: 'ONLINE',
                        scope: 'TENANT',
                        monitors: { some: { monitorId: 'monitor-1' } },
                    },
                },
                orderBy: { checkedAt: 'desc' },
            });
            expect(stateService.record).toHaveBeenCalledWith('monitor-1', {
                success: true,
                latency: 30,
                error: null,
                source: 'LOCAL',
                checkedAt: checkResult.checkedAt,
                ssl: undefined,
                localSuccess: false,
                rescuedByProbe: true,
                serviceVerdict: 'SUCCESS',
                statusCode: null,
                ruleMatched: false,
                ruleGroupIds: [],
                revision: 1,
                evaluated: true,
                failureKind: null,
                meta: undefined,
            });
        });

        it('keeps a local failure UP when an assigned system probe succeeded', async () => {
            const {
                service,
                prisma,
                stateService,
                httpChecker,
                systemProbeScheduler,
            } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            httpChecker.check.mockResolvedValue({
                success: false,
                latency: 30,
                error: 'HTTP 500',
                checkedAt: checkResult.checkedAt,
            });
            systemProbeScheduler.getAssignedProbes.mockResolvedValue([
                'system-probe-1',
            ]);
            prisma.probeResult.findMany
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([
                    {
                        id: 'probe-result-1',
                        probeId: 'system-probe-1',
                        target: monitorRow.target,
                        success: true,
                        latency: 40,
                        error: null,
                        checkedAt: checkResult.checkedAt,
                    },
                ]);

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(prisma.probeResult.findMany).toHaveBeenNthCalledWith(2, {
                where: {
                    target: monitorRow.target,
                    monitorId: monitorRow.id,
                    configRevision: undefined,
                    probeId: { in: ['system-probe-1'] },
                    checkedAt: { gte: expect.any(Date) },
                    probe: {
                        scope: 'SYSTEM',
                        enabled: true,
                        status: 'ONLINE',
                    },
                },
                orderBy: { checkedAt: 'desc' },
            });
            expect(stateService.record).toHaveBeenCalledWith(
                'monitor-1',
                expect.objectContaining({
                    success: true,
                    error: null,
                    localSuccess: false,
                    rescuedByProbe: true,
                }),
            );
        });

        it('does not let probe success override an SSL failure', async () => {
            const { service, prisma, stateService, httpChecker } =
                createService();
            const ssl = {
                expiresAt: new Date('2026-03-10T12:00:00.000Z'),
                daysRemaining: 5,
                issuer: 'Example CA',
                subject: 'api.example.com',
            };
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                checkSsl: true,
            });
            httpChecker.check.mockResolvedValue({
                success: false,
                latency: 30,
                error: 'SSL certificate expires in 5 day(s)',
                checkedAt: checkResult.checkedAt,
                ssl,
            });
            prisma.probeResult.findMany.mockResolvedValue([
                {
                    id: 'probe-result-1',
                    probeId: 'probe-1',
                    target: monitorRow.target,
                    success: true,
                    latency: 40,
                    error: null,
                    checkedAt: checkResult.checkedAt,
                },
            ]);

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(prisma.probeResult.findMany).not.toHaveBeenCalled();
            expect(stateService.record).toHaveBeenCalledWith(
                'monitor-1',
                expect.objectContaining({
                    success: false,
                    error: 'SSL certificate expires in 5 day(s)',
                    ssl,
                }),
            );
        });

        it('keeps a local failure DOWN when every fresh bound probe failed', async () => {
            const { service, prisma, stateService, httpChecker } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            httpChecker.check.mockResolvedValue({
                success: false,
                latency: 30,
                error: 'HTTP 500',
                checkedAt: checkResult.checkedAt,
            });
            prisma.probeResult.findMany.mockResolvedValue([
                {
                    id: 'probe-result-1',
                    probeId: 'probe-1',
                    target: monitorRow.target,
                    success: false,
                    latency: 40,
                    error: 'timeout',
                    checkedAt: checkResult.checkedAt,
                },
            ]);

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(stateService.record).toHaveBeenCalledWith(
                'monitor-1',
                expect.objectContaining({
                    success: false,
                    error: 'HTTP 500; all 1 probe result(s) failed',
                }),
            );
        });

        it('throws when the monitor is not in the project', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue(null);

            await expect(
                service.checkMonitorForProject('project-1', 'monitor-1', {
                    type: 'USER',
                    userId: 'user-1',
                }),
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('ingestProbeReport', () => {
        it('keeps versioned probes usable after a compatible definition update', async () => {
            const { service, prisma, stateService } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                revision: 2,
                configRevision: 2,
            });
            prisma.checkLog.findFirst
                .mockResolvedValueOnce({
                    ...checkResult,
                    success: false,
                    localSuccess: false,
                    revision: 2,
                    configRevision: 2,
                    failureKind: 'TRANSPORT',
                })
                .mockResolvedValueOnce(null);
            prisma.probeResult.findMany.mockResolvedValue([{ success: true }]);
            await service.ingestProbeReportForMonitor('monitor-1', {
                target: monitorRow.target,
                success: true,
                latency: 20,
                configRevision: 2,
            });
            expect(stateService.record).toHaveBeenCalledWith(
                'monitor-1',
                expect.objectContaining({
                    revision: 2,
                    configRevision: 2,
                    success: true,
                    rescuedByProbe: true,
                }),
            );
            expect(prisma.probeResult.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ configRevision: 2 }),
                }),
            );
        });

        it('does not reuse an effective rescued verdict as raw local service evidence', async () => {
            const { service, prisma, stateService } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            prisma.checkLog.findFirst
                .mockResolvedValueOnce({
                    success: true,
                    localSuccess: false,
                    serviceVerdict: 'SUCCESS',
                    localServiceVerdict: 'FAILURE',
                    latency: 30,
                    error: null,
                    checkedAt: new Date(),
                })
                .mockResolvedValueOnce(null);
            prisma.probeResult.findMany.mockResolvedValue([{ success: false }]);
            await service.ingestProbeReportForMonitor('monitor-1', {
                target: monitorRow.target,
                success: false,
                latency: 20,
                checkedAt: new Date(),
            });
            expect(stateService.record).toHaveBeenCalledWith(
                'monitor-1',
                expect.objectContaining({
                    success: false,
                    serviceVerdict: 'FAILURE',
                    localServiceVerdict: 'FAILURE',
                    sslVerdict: 'NO_EVIDENCE',
                }),
            );
        });

        it('uses fresh probe service success without overriding an independent SSL failure', async () => {
            const { service, prisma, stateService } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                checkSsl: true,
                configRevision: 1,
            });
            prisma.checkLog.findFirst
                .mockResolvedValueOnce({
                    success: false,
                    localSuccess: false,
                    serviceVerdict: 'NO_EVIDENCE',
                    localServiceVerdict: 'NO_EVIDENCE',
                    sslVerdict: 'INVALID',
                    latency: 30,
                    error: 'SSL invalid',
                    checkedAt: new Date(),
                })
                .mockResolvedValueOnce(null);
            prisma.probeResult.findMany.mockResolvedValue([{ success: true }]);
            await service.ingestProbeReportForMonitor('monitor-1', {
                target: monitorRow.target,
                success: true,
                latency: 20,
                checkedAt: new Date(),
            });
            expect(stateService.record).toHaveBeenCalledWith(
                'monitor-1',
                expect.objectContaining({
                    success: false,
                    serviceVerdict: 'SUCCESS',
                    localServiceVerdict: 'NO_EVIDENCE',
                    sslVerdict: 'NO_EVIDENCE',
                    rescuedByProbe: false,
                }),
            );
        });
        it('re-evaluates the latest local outcome when a probe report arrives', async () => {
            const { service, prisma, stateService } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            prisma.checkLog.findFirst.mockResolvedValue({
                id: 'log-1',
                monitorId: 'monitor-1',
                success: false,
                latency: 30,
                error: 'HTTP 500',
                source: 'LOCAL',
                checkedAt: checkResult.checkedAt,
            });
            prisma.probeResult.findMany.mockResolvedValue([
                {
                    id: 'probe-result-1',
                    probeId: 'probe-1',
                    target: monitorRow.target,
                    success: true,
                    latency: 20,
                    error: null,
                    checkedAt: checkResult.checkedAt,
                },
            ]);

            const result = await service.ingestProbeReportForMonitor(
                'monitor-1',
                {
                    target: 'https://api.example.com/health',
                    success: true,
                    latency: 20,
                },
            );

            expect(prisma.monitor.findFirst).toHaveBeenCalledWith({
                where: {
                    id: 'monitor-1',
                    target: 'https://api.example.com/health',
                    deletedAt: null,
                    enabled: true,
                },
            });
            expect(prisma.checkLog.findFirst).toHaveBeenCalledWith({
                where: {
                    monitorId: 'monitor-1',
                    source: 'LOCAL',
                    configRevision: undefined,
                },
                orderBy: { checkedAt: 'desc' },
            });
            expect(stateService.record).toHaveBeenCalledWith('monitor-1', {
                success: true,
                latency: 30,
                error: null,
                source: 'PROBE',
                probeRoundWindowMs: 15000,
                checkedAt: expect.any(Date),
                ssl: undefined,
                localSuccess: false,
                rescuedByProbe: true,
                serviceVerdict: 'SUCCESS',
                localServiceVerdict: 'FAILURE',
                sslVerdict: 'NO_EVIDENCE',
                statusCode: null,
                ruleMatched: false,
                ruleGroupIds: [],
                revision: 1,
                evaluated: true,
                failureKind: null,
                meta: undefined,
            });
            expect(result?.monitorId).toBe('monitor-1');
        });

        it('carries the probe-reported status code into the check outcome', async () => {
            const { service, prisma, stateService } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            prisma.checkLog.findFirst.mockResolvedValue({
                id: 'log-1',
                monitorId: 'monitor-1',
                success: false,
                latency: 30,
                error: 'HTTP 500',
                source: 'LOCAL',
                checkedAt: checkResult.checkedAt,
            });
            prisma.probeResult.findMany.mockResolvedValue([
                {
                    id: 'probe-result-1',
                    probeId: 'probe-1',
                    target: monitorRow.target,
                    success: false,
                    latency: 40,
                    error: 'timeout',
                    checkedAt: checkResult.checkedAt,
                },
            ]);

            await service.ingestProbeReportForMonitor('monitor-1', {
                target: 'https://api.example.com/health',
                success: false,
                latency: 40,
                statusCode: 503,
            });

            expect(stateService.record).toHaveBeenCalledWith(
                'monitor-1',
                expect.objectContaining({ statusCode: 503 }),
            );
        });

        it('does not apply a probe report before any local baseline exists', async () => {
            const { service, prisma, stateService } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            prisma.checkLog.findFirst.mockResolvedValue(null);

            const result = await service.ingestProbeReportForMonitor(
                'monitor-1',
                {
                    target: 'https://api.example.com/health',
                    success: true,
                    latency: 5,
                },
            );

            expect(result).toBeNull();
            expect(stateService.record).not.toHaveBeenCalled();
        });

        it('ignores a report for a round that was already folded', async () => {
            const { service, prisma, stateService } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            prisma.checkLog.findFirst
                .mockResolvedValueOnce({
                    id: 'log-1',
                    monitorId: 'monitor-1',
                    success: false,
                    latency: 30,
                    error: 'HTTP 500',
                    source: 'LOCAL',
                    checkedAt: new Date('2026-03-05T12:00:00.000Z'),
                })
                .mockResolvedValueOnce({ checkedAt: new Date() });

            const result = await service.ingestProbeReportForMonitor(
                'monitor-1',
                {
                    target: 'https://api.example.com/health',
                    success: true,
                    latency: 40,
                    error: null,
                },
            );

            expect(result).toBeNull();
            expect(stateService.record).not.toHaveBeenCalled();
        });

        it('returns null when no monitor owns the target', async () => {
            const { service, prisma, stateService } = createService();
            prisma.monitor.findFirst.mockResolvedValue(null);

            const result = await service.ingestProbeReportForMonitor(
                'monitor-1',
                {
                    target: 'https://unknown.example.com',
                    success: true,
                    latency: 5,
                },
            );

            expect(result).toBeNull();
            expect(stateService.record).not.toHaveBeenCalled();
        });
    });

    describe('enqueueDueChecks', () => {
        function createQueue() {
            return {
                add: jest.fn().mockResolvedValue({ id: 'job-1' }),
            } as unknown as Queue<MonitorCheckJobData> & { add: jest.Mock };
        }

        it('enqueues one check job per monitor whose interval elapsed', async () => {
            const { service, prisma } = createService();
            const queue = createQueue();
            prisma.monitor.findMany.mockResolvedValue([
                { ...monitorRow, state: { lastLocalCheckAt: null } },
                {
                    ...monitorRow,
                    id: 'monitor-2',
                    state: { lastLocalCheckAt: new Date() },
                },
            ]);

            const result = await service.enqueueDueChecks(queue);

            expect(result).toEqual({ due: 1, enqueued: 1 });
            expect(queue.add).toHaveBeenCalledTimes(1);
            expect(queue.add).toHaveBeenCalledWith(
                MONITOR_CHECK_JOB,
                { monitorId: 'monitor-1' },
                expect.objectContaining({
                    // No TTL: the key must be released when the job finishes,
                    // otherwise the monitor would be skipped until it expires.
                    deduplication: { id: 'monitor-check:monitor-1' },
                }),
            );
        });

        it('keeps enqueuing the remaining monitors when one add fails', async () => {
            const { service, prisma } = createService();
            const queue = createQueue();
            queue.add
                .mockRejectedValueOnce(new Error('redis down'))
                .mockResolvedValueOnce({ id: 'job-2' });
            prisma.monitor.findMany.mockResolvedValue([
                { ...monitorRow, state: { lastLocalCheckAt: null } },
                {
                    ...monitorRow,
                    id: 'monitor-2',
                    state: { lastLocalCheckAt: null },
                },
            ]);

            const result = await service.enqueueDueChecks(queue);

            expect(result).toEqual({ due: 2, enqueued: 1 });
            expect(queue.add).toHaveBeenCalledTimes(2);
        });
    });

    describe('executeMonitor', () => {
        it('runs a scheduled local check for the monitor', async () => {
            const { service, prisma, stateService, httpChecker } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);

            const result = await service.executeMonitor('monitor-1');

            expect(httpChecker.check).toHaveBeenCalled();
            expect(stateService.record).toHaveBeenCalledWith(
                'monitor-1',
                expect.objectContaining({ source: 'LOCAL' }),
            );
            expect(result?.monitorId).toBe('monitor-1');
        });

        it('does nothing when the monitor is gone or disabled', async () => {
            const { service, prisma, stateService, httpChecker } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(null);

            const result = await service.executeMonitor('monitor-1');

            expect(result).toBeNull();
            expect(httpChecker.check).not.toHaveBeenCalled();
            expect(stateService.record).not.toHaveBeenCalled();
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
                    success: false,
                    latency: 30,
                    error: 'Unexpected status 500 (expected 200)',
                    source: 'LOCAL',
                    checkedAt: new Date('2026-03-05T12:00:00.000Z'),
                },
            ]);
            prisma.checkLog.count.mockResolvedValue(1);

            const result = await service.listCheckLogs(
                'project-1',
                'monitor-1',
                {
                    success: false,
                    page: 1,
                    limit: 5,
                },
                { type: 'USER', userId: 'user-1' },
            );

            expect(prisma.checkLog.findMany).toHaveBeenCalledWith({
                where: {
                    monitorId: 'monitor-1',
                    organizationId: 'org-1',
                    projectId: 'project-1',
                    success: false,
                },
                orderBy: { checkedAt: 'desc' },
                skip: 0,
                take: 5,
            });
            expect(result.meta.total).toBe(1);
            expect(result.data[0].success).toBe(false);
        });

        it('throws when the monitor is not in the project', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue(null);

            await expect(
                service.listCheckLogs(
                    'project-1',
                    'monitor-1',
                    {},
                    { type: 'USER', userId: 'user-1' },
                ),
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('availability alert', () => {
        const alertMonitor = {
            ...monitorRow,
            availabilityEnabled: true,
            availabilityThreshold: 90,
            availabilityWindow: 10,
        };

        const recordWith = (overrides: Record<string, unknown>) => ({
            monitor: alertMonitor,
            state: { ...stateRow, ...overrides },
            transition: {
                previousStatus: 'UP',
                previousFailCount: 0,
                status: 'DOWN',
                failCount: 3,
                changed: true,
            },
        });

        it('does not create a second nontransactional availability notification', async () => {
            const { service, prisma, stateService, notifierService } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(alertMonitor);
            stateService.record.mockResolvedValue(
                recordWith({
                    status: 'DOWN',
                    failCount: 3,
                    availabilityAlertActive: false,
                }),
            );
            prisma.checkLog.findMany.mockResolvedValue([
                { ruleMatched: true },
                { ruleMatched: true },
                { ruleMatched: true },
                { ruleMatched: false },
            ]);

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(prisma.checkLog.findMany).not.toHaveBeenCalled();
            expect(
                notifierService.notifyAvailabilityAlert,
            ).not.toHaveBeenCalled();
            expect(stateService.record).toHaveBeenCalledTimes(1);
        });

        it('stays silent while already alerting', async () => {
            const { service, prisma, stateService, notifierService } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(alertMonitor);
            stateService.record.mockResolvedValue(
                recordWith({
                    status: 'DOWN',
                    failCount: 3,
                    availabilityAlertActive: true,
                }),
            );
            prisma.checkLog.findMany.mockResolvedValue([
                { ruleMatched: true },
                { ruleMatched: true },
                { ruleMatched: true },
            ]);

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(
                notifierService.notifyAvailabilityAlert,
            ).not.toHaveBeenCalled();
            expect(prisma.monitorState.update).not.toHaveBeenCalled();
        });

        it('delegates recovery to the transactional state writer', async () => {
            const { service, prisma, stateService, notifierService } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(alertMonitor);
            stateService.record.mockResolvedValue(
                recordWith({
                    status: 'UP',
                    failCount: 0,
                    availabilityAlertActive: true,
                }),
            );
            prisma.checkLog.findMany.mockResolvedValue(
                Array.from({ length: 10 }, () => ({ ruleMatched: false })),
            );

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(
                notifierService.notifyAvailabilityRecovery,
            ).not.toHaveBeenCalled();
            expect(prisma.monitorState.update).not.toHaveBeenCalled();
            expect(stateService.record).toHaveBeenCalledTimes(1);
        });

        it('does not alert while consecutive failures are below the threshold', async () => {
            const { service, prisma, stateService, notifierService } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(alertMonitor);
            stateService.record.mockResolvedValue(
                recordWith({
                    status: 'DEGRADED',
                    failCount: 1,
                    availabilityAlertActive: false,
                }),
            );
            prisma.checkLog.findMany.mockResolvedValue([
                { ruleMatched: true },
                { ruleMatched: false },
            ]);

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(
                notifierService.notifyAvailabilityAlert,
            ).not.toHaveBeenCalled();
            expect(prisma.monitorState.update).not.toHaveBeenCalled();
        });

        it('does not alert when availability is at or above the threshold', async () => {
            const { service, prisma, stateService, notifierService } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(alertMonitor);
            stateService.record.mockResolvedValue(
                recordWith({
                    status: 'DOWN',
                    failCount: 3,
                    availabilityAlertActive: false,
                }),
            );
            // 10 checks, 9 healthy => 90%, not below the 90% threshold.
            prisma.checkLog.findMany.mockResolvedValue([
                ...Array.from({ length: 9 }, () => ({ ruleMatched: false })),
                { ruleMatched: true },
            ]);

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(
                notifierService.notifyAvailabilityAlert,
            ).not.toHaveBeenCalled();
            expect(
                notifierService.notifyAvailabilityRecovery,
            ).not.toHaveBeenCalled();
            expect(prisma.monitorState.update).not.toHaveBeenCalled();
        });

        it('does nothing when availability alerting is disabled', async () => {
            const { service, prisma, stateService, notifierService } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            stateService.record.mockResolvedValue(
                recordWith({ status: 'DOWN', failCount: 3 }),
            );

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(prisma.checkLog.findMany).not.toHaveBeenCalled();
            expect(
                notifierService.notifyAvailabilityAlert,
            ).not.toHaveBeenCalled();
        });
    });

    describe('node anomaly condition rules', () => {
        const binding = {
            id: 'binding-1',
            monitorId: 'monitor-1',
            ruleGroupId: 'rg-1',
            priority: 0,
            enabled: true,
            ruleGroup: {
                id: 'rg-1',
                organizationId: 'org-1',
                projectId: null,
                name: 'High latency',
                description: null,
                tree: {
                    type: 'condition',
                    id: 'c1',
                    field: 'latency',
                    operator: 'gt',
                    value: 100,
                },
                fieldsUsed: ['latency'],
                enabled: true,
                createdAt: new Date('2026-03-05T12:00:00.000Z'),
                updatedAt: new Date('2026-03-05T12:00:00.000Z'),
                deletedAt: null,
            },
        };

        const noChangeTransition = {
            previousStatus: 'UP',
            previousFailCount: 0,
            status: 'UP',
            failCount: 0,
            changed: false,
        };

        it('records the rule verdict onto the check log when a bound rule matches', async () => {
            const { service, prisma, stateService, ruleEvaluator, ruleGroups } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            stateService.record.mockResolvedValue({
                monitor: monitorRow,
                state: stateRow,
                transition: noChangeTransition,
            });
            ruleGroups.findBindingsForMonitor.mockResolvedValue([binding]);
            ruleEvaluator.evaluate.mockReturnValue(true);

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(ruleGroups.findBindingsForMonitor).toHaveBeenCalledWith(
                'monitor-1',
            );
            expect(ruleEvaluator.evaluate).toHaveBeenCalledWith(
                binding.ruleGroup.tree,
                {
                    success: true,
                    latency: 12,
                    certDaysRemaining: undefined,
                    statusCode: undefined,
                },
            );
            expect(stateService.record).toHaveBeenCalledWith(
                'monitor-1',
                expect.objectContaining({
                    ruleMatched: true,
                    ruleGroupIds: ['rg-1'],
                }),
            );
        });

        it('records ruleMatched=false when no rule matches', async () => {
            const { service, prisma, stateService, ruleEvaluator, ruleGroups } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            stateService.record.mockResolvedValue({
                monitor: monitorRow,
                state: stateRow,
                transition: noChangeTransition,
            });
            ruleGroups.findBindingsForMonitor.mockResolvedValue([binding]);
            ruleEvaluator.evaluate.mockReturnValue(false);

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(stateService.record).toHaveBeenCalledWith(
                'monitor-1',
                expect.objectContaining({
                    ruleMatched: false,
                    ruleGroupIds: [],
                }),
            );
        });

        it('falls back to !success when the monitor has no bound rule group', async () => {
            const { service, prisma, stateService, ruleEvaluator, ruleGroups } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            stateService.record.mockResolvedValue({
                monitor: monitorRow,
                state: stateRow,
                transition: noChangeTransition,
            });
            ruleGroups.findBindingsForMonitor.mockResolvedValue([]);

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(ruleEvaluator.evaluate).not.toHaveBeenCalled();
            expect(stateService.record).toHaveBeenCalledWith(
                'monitor-1',
                expect.objectContaining({
                    ruleMatched: false,
                    ruleGroupIds: [],
                }),
            );
        });

        it('passes the actual HTTP status code into the rule context', async () => {
            const {
                service,
                prisma,
                stateService,
                httpChecker,
                ruleEvaluator,
                ruleGroups,
            } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            stateService.record.mockResolvedValue({
                monitor: monitorRow,
                state: stateRow,
                transition: noChangeTransition,
            });
            httpChecker.check.mockResolvedValue({
                success: false,
                latency: 30,
                error: 'Unexpected status 503 (expected 200)',
                checkedAt: checkResult.checkedAt,
                statusCode: 503,
            });
            ruleGroups.findBindingsForMonitor.mockResolvedValue([binding]);
            ruleEvaluator.evaluate.mockReturnValue(true);

            await service.checkMonitorForProject('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(ruleEvaluator.evaluate).toHaveBeenCalledWith(
                binding.ruleGroup.tree,
                expect.objectContaining({ statusCode: 503 }),
            );
        });
    });
});

describe('probeResultWindowMs', () => {
    it('keeps the two minute floor for fast monitors', () => {
        expect(probeResultWindowMs(10)).toBe(2 * 60 * 1000);
        expect(probeResultWindowMs(60)).toBe(2 * 60 * 1000);
    });

    it('scales with the monitor interval', () => {
        expect(probeResultWindowMs(300)).toBe(10 * 60 * 1000);
    });

    it('caps the window for slow monitors', () => {
        expect(probeResultWindowMs(86_400)).toBe(15 * 60 * 1000);
    });
});

describe('probeReportDedupWindowMs', () => {
    it('scales with the monitor interval', () => {
        expect(probeReportDedupWindowMs(10)).toBe(5 * 1000);
        expect(probeReportDedupWindowMs(60)).toBe(15 * 1000);
    });

    it('never suppresses reports for longer than the cap', () => {
        expect(probeReportDedupWindowMs(600)).toBe(30 * 1000);
    });
});
