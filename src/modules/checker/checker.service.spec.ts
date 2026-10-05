import { NotFoundException } from '@nestjs/common';
import { CheckerService } from './checker.service';
import type { PrismaService } from '../../database/prisma.service';
import type { StateService } from '../state/state.service';
import type { NotifierService } from '../notifier/notifier.service';

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
        monitor: { findFirst: jest.fn(), findMany: jest.fn() },
        checkLog: {
            findFirst: jest.fn(),
            findMany: jest.fn(),
            count: jest.fn(),
        },
        probeResult: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const stateService = {
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
    };
    const httpChecker = { check: jest.fn().mockResolvedValue(checkResult) };
    const tcpChecker = { check: jest.fn().mockResolvedValue(checkResult) };

    const service = new CheckerService(
        prisma as unknown as PrismaService,
        stateService as unknown as StateService,
        notifierService as unknown as NotifierService,
        httpChecker as never,
        tcpChecker,
    );

    return {
        service,
        prisma,
        stateService,
        notifierService,
        httpChecker,
        tcpChecker,
    };
}

describe('CheckerService', () => {
    describe('checkMonitorForProject', () => {
        it('runs an HTTP check and notifies on a status change', async () => {
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
            );

            expect(prisma.monitor.findFirst).toHaveBeenCalledWith({
                where: {
                    id: 'monitor-1',
                    projectId: 'project-1',
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
            });
            expect(notifierService.notifyTransition).toHaveBeenCalledTimes(1);
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

            await service.checkMonitorForProject('project-1', 'monitor-1');

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

            await service.checkMonitorForProject('project-1', 'monitor-1');

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

            await service.checkMonitorForProject('project-1', 'monitor-1');

            expect(prisma.probeResult.findMany).toHaveBeenCalledWith({
                where: {
                    target: monitorRow.target,
                    checkedAt: { gte: expect.any(Date) },
                    probe: {
                        organizationId: 'org-1',
                        enabled: true,
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
            });
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

            await service.checkMonitorForProject('project-1', 'monitor-1');

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

            await service.checkMonitorForProject('project-1', 'monitor-1');

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
                service.checkMonitorForProject('project-1', 'monitor-1'),
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('ingestProbeReport', () => {
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

            const result = await service.ingestProbeReport('org-1', {
                target: 'https://api.example.com/health',
                success: true,
                latency: 20,
            });

            expect(prisma.monitor.findFirst).toHaveBeenCalledWith({
                where: {
                    organizationId: 'org-1',
                    target: 'https://api.example.com/health',
                    deletedAt: null,
                    enabled: true,
                },
            });
            expect(prisma.checkLog.findFirst).toHaveBeenCalledWith({
                where: { monitorId: 'monitor-1', source: 'LOCAL' },
                orderBy: { checkedAt: 'desc' },
            });
            expect(stateService.record).toHaveBeenCalledWith('monitor-1', {
                success: true,
                latency: 30,
                error: null,
                source: 'LOCAL',
                checkedAt: expect.any(Date),
                ssl: undefined,
            });
            expect(result?.monitorId).toBe('monitor-1');
        });

        it('does not apply a probe report before any local baseline exists', async () => {
            const { service, prisma, stateService } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            prisma.checkLog.findFirst.mockResolvedValue(null);

            const result = await service.ingestProbeReport('org-1', {
                target: 'https://api.example.com/health',
                success: true,
                latency: 5,
            });

            expect(result).toBeNull();
            expect(stateService.record).not.toHaveBeenCalled();
        });

        it('returns null when no monitor owns the target', async () => {
            const { service, prisma, stateService } = createService();
            prisma.monitor.findFirst.mockResolvedValue(null);

            const result = await service.ingestProbeReport('org-1', {
                target: 'https://unknown.example.com',
                success: true,
                latency: 5,
            });

            expect(result).toBeNull();
            expect(stateService.record).not.toHaveBeenCalled();
        });
    });

    describe('runDueChecks', () => {
        it('only checks monitors whose interval elapsed', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findMany.mockResolvedValue([
                { ...monitorRow, state: { lastCheckAt: null } },
                {
                    ...monitorRow,
                    id: 'monitor-2',
                    state: { lastCheckAt: new Date() },
                },
            ]);

            const result = await service.runDueChecks();

            expect(result).toEqual({ due: 1, checked: 1 });
        });

        it('keeps checking the remaining monitors when one throws', async () => {
            const { service, prisma, stateService } = createService();
            prisma.monitor.findMany.mockResolvedValue([
                { ...monitorRow, state: { lastCheckAt: null } },
                {
                    ...monitorRow,
                    id: 'monitor-2',
                    state: { lastCheckAt: null },
                },
            ]);
            stateService.record
                .mockRejectedValueOnce(new Error('db down'))
                .mockResolvedValueOnce({
                    monitor: monitorRow,
                    state: stateRow,
                    transition: { changed: false },
                });

            const result = await service.runDueChecks();

            expect(result.due).toBe(2);
            expect(result.checked).toBe(1);
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
            );

            expect(prisma.checkLog.findMany).toHaveBeenCalledWith({
                where: { monitorId: 'monitor-1', success: false },
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
                service.listCheckLogs('project-1', 'monitor-1', {}),
            ).rejects.toThrow(NotFoundException);
        });
    });
});
