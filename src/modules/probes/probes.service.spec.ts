import {
    BadRequestException,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { ProbesService } from './probes.service';
import type { PrismaService } from '../../infra/database/prisma.service';
import type { CheckerService } from '../checker/checker.service';

const probeRow = {
    id: 'probe-1',
    organizationId: 'org-1',
    scope: 'TENANT',
    name: 'Tokyo probe',
    provider: 'TENCENT',
    region: 'ap-northeast-1',
    callbackUrl: 'https://probe.example.com/callback',
    secret: 'secret-1',
    enabled: true,
    lastHeartbeat: null,
    status: 'OFFLINE',
    maxTenants: 0,
    priority: 0,
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
};

const monitorSummary = {
    id: 'monitor-1',
    name: 'Production API',
    type: 'HTTP',
    target: 'https://api.example.com/health',
    interval: 60,
    timeout: 5000,
    expectedStatus: 200,
    failureThreshold: 3,
    enabled: true,
    deletedAt: null,
};

function createService() {
    const prisma = {
        probe: {
            create: jest.fn(),
            findMany: jest.fn(),
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
            delete: jest.fn(),
        },
        probeResult: {
            findMany: jest.fn(),
            count: jest.fn(),
            createMany: jest.fn(),
        },
        probeExecution: {
            findMany: jest.fn(),
            count: jest.fn(),
            create: jest.fn(),
        },
        monitorProbe: {
            createMany: jest.fn(),
            findUnique: jest.fn(),
            delete: jest.fn(),
        },
        monitor: { findMany: jest.fn(), findFirst: jest.fn() },
    };
    const checkerService = {
        ingestProbeReport: jest.fn(),
        ingestProbeReportForMonitor: jest.fn(),
    };
    const systemProbeScheduler = {
        rebalance: jest.fn().mockResolvedValue({}),
        getAssignedMonitorIds: jest.fn().mockResolvedValue([]),
    };
    const billingService = {
        assertFeatureAllowed: jest.fn().mockResolvedValue(undefined),
        assertCanCreate: jest.fn().mockResolvedValue(undefined),
    };
    const configService = {
        get: jest.fn().mockReturnValue({ offlineAfterSeconds: 120 }),
    };

    const service = new ProbesService(
        prisma as unknown as PrismaService,
        checkerService as unknown as CheckerService,
        systemProbeScheduler as never,
        billingService as never,
        configService as never,
        { register: jest.fn() } as never,
    );

    return {
        service,
        prisma,
        checkerService,
        systemProbeScheduler,
        billingService,
        configService,
    };
}

describe('ProbesService', () => {
    describe('create', () => {
        it('generates a shared secret for the new probe', async () => {
            const { service, prisma } = createService();
            prisma.probe.create.mockImplementation(
                ({ data }: { data: Record<string, unknown> }) =>
                    Promise.resolve({ ...probeRow, ...data }),
            );

            const result = await service.create('org-1', {
                name: 'Tokyo probe',
                provider: 'TENCENT',
                region: 'ap-northeast-1',
                callbackUrl: 'https://probe.example.com/callback',
            });

            const created = prisma.probe.create.mock.calls[0][0];
            expect(created.data.organizationId).toBe('org-1');
            expect(created.data.scope).toBe('TENANT');
            expect(created.data.secret).toMatch(/^tnt_[0-9a-f]{64}$/);
            expect(result.secret).toMatch(/^tnt_[0-9a-f]{64}$/);
            expect(result.monitors).toEqual([]);
        });
    });

    describe('recordHeartbeat', () => {
        it('marks a tenant probe online and returns directly bound monitors', async () => {
            const { service, prisma } = createService();
            prisma.probe.findUnique.mockResolvedValue(probeRow);
            prisma.probe.update.mockResolvedValue({
                ...probeRow,
                status: 'ONLINE',
                lastHeartbeat: new Date('2026-03-05T12:00:00.000Z'),
                monitors: [
                    { monitor: monitorSummary },
                    {
                        monitor: {
                            ...monitorSummary,
                            id: 'monitor-2',
                            enabled: false,
                        },
                    },
                    {
                        monitor: {
                            ...monitorSummary,
                            id: 'monitor-3',
                            deletedAt: new Date('2026-03-05T12:00:00.000Z'),
                        },
                    },
                ],
            });

            const result = await service.recordHeartbeat('secret-1');

            expect(prisma.probe.findUnique).toHaveBeenCalledWith({
                where: { secret: 'secret-1' },
            });
            expect(result.probe.status).toBe('ONLINE');
            expect(result.monitors).toEqual([
                {
                    id: 'monitor-1',
                    name: 'Production API',
                    type: 'HTTP',
                    target: 'https://api.example.com/health',
                    interval: 60,
                    timeout: 5000,
                    expectedStatus: 200,
                },
            ]);
            expect(prisma.probeExecution.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    probeId: 'probe-1',
                    monitorId: null,
                    target: 'heartbeat',
                    trigger: 'CALLBACK',
                    status: 'SUCCESS',
                    success: true,
                    responseMeta: { monitorCount: 1 },
                }),
            });
        });

        it('returns dynamically assigned monitors once a system probe comes online', async () => {
            const { service, prisma, systemProbeScheduler } = createService();
            prisma.probe.findUnique.mockResolvedValue({
                ...probeRow,
                organizationId: null,
                scope: 'SYSTEM',
                secret: 'sys_secret',
            });
            prisma.probe.update.mockResolvedValue({
                ...probeRow,
                organizationId: null,
                scope: 'SYSTEM',
                secret: 'sys_secret',
                status: 'ONLINE',
                lastHeartbeat: new Date('2026-03-05T12:00:00.000Z'),
                monitors: [],
            });
            systemProbeScheduler.getAssignedMonitorIds.mockResolvedValue([
                'monitor-1',
            ]);
            prisma.monitor.findMany.mockResolvedValue([monitorSummary]);

            const result = await service.recordHeartbeat('sys_secret');

            // A probe that was offline has to enter the assignment table before
            // its monitors are read, otherwise it stays idle for up to an hour.
            expect(systemProbeScheduler.rebalance).toHaveBeenCalledTimes(1);
            expect(prisma.monitor.findMany).toHaveBeenCalledWith({
                where: {
                    id: { in: ['monitor-1'] },
                    enabled: true,
                    deletedAt: null,
                },
                select: expect.any(Object),
            });
            expect(result.monitors).toEqual([
                {
                    id: 'monitor-1',
                    name: 'Production API',
                    type: 'HTTP',
                    target: 'https://api.example.com/health',
                    interval: 60,
                    timeout: 5000,
                    expectedStatus: 200,
                },
            ]);
        });

        it('does not rebuild the assignment table on a steady-state heartbeat', async () => {
            const { service, prisma, systemProbeScheduler } = createService();
            prisma.probe.findUnique.mockResolvedValue({
                ...probeRow,
                organizationId: null,
                scope: 'SYSTEM',
                secret: 'sys_secret',
                status: 'ONLINE',
            });
            prisma.probe.update.mockResolvedValue({
                ...probeRow,
                organizationId: null,
                scope: 'SYSTEM',
                secret: 'sys_secret',
                status: 'ONLINE',
                monitors: [],
            });
            systemProbeScheduler.getAssignedMonitorIds.mockResolvedValue([]);

            await service.recordHeartbeat('sys_secret');

            expect(systemProbeScheduler.rebalance).not.toHaveBeenCalled();
        });

        it('rejects a missing secret', async () => {
            const { service, prisma } = createService();

            await expect(service.recordHeartbeat('')).rejects.toThrow(
                UnauthorizedException,
            );
            expect(prisma.probe.findUnique).not.toHaveBeenCalled();
        });

        it('rejects an unknown secret', async () => {
            const { service, prisma } = createService();
            prisma.probe.findUnique.mockResolvedValue(null);

            await expect(service.recordHeartbeat('nope')).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it('rejects a disabled probe', async () => {
            const { service, prisma } = createService();
            prisma.probe.findUnique.mockResolvedValue({
                ...probeRow,
                enabled: false,
            });

            await expect(service.recordHeartbeat('secret-1')).rejects.toThrow(
                UnauthorizedException,
            );
        });
    });

    describe('recordResults', () => {
        it('stores raw results and folds them into monitor state', async () => {
            const { service, prisma, checkerService } = createService();
            prisma.probe.findUnique.mockResolvedValue(probeRow);
            prisma.probeResult.createMany.mockResolvedValue({ count: 2 });
            prisma.probe.update.mockResolvedValue(probeRow);
            checkerService.ingestProbeReport
                .mockResolvedValueOnce({
                    monitorId: 'monitor-1',
                    status: 'DOWN',
                    changed: true,
                })
                .mockResolvedValueOnce(null);

            const result = await service.recordResults('secret-1', [
                {
                    target: 'https://api.example.com/health',
                    success: false,
                    latency: 30,
                    error: 'boom',
                },
                {
                    target: 'https://unknown.example.com',
                    success: true,
                    latency: 5,
                },
            ]);

            expect(prisma.probeResult.createMany).toHaveBeenCalledWith({
                data: [
                    {
                        probeId: 'probe-1',
                        target: 'https://api.example.com/health',
                        success: false,
                        latency: 30,
                        error: 'boom',
                        checkedAt: expect.any(Date),
                    },
                    {
                        probeId: 'probe-1',
                        target: 'https://unknown.example.com',
                        success: true,
                        latency: 5,
                        error: null,
                        checkedAt: expect.any(Date),
                    },
                ],
            });
            expect(checkerService.ingestProbeReport).toHaveBeenCalledWith(
                'org-1',
                expect.objectContaining({
                    target: 'https://api.example.com/health',
                    success: false,
                }),
            );
            expect(result).toEqual({
                accepted: 2,
                applied: 1,
                outcomes: [
                    {
                        target: 'https://api.example.com/health',
                        monitorId: 'monitor-1',
                        status: 'DOWN',
                        changed: true,
                    },
                ],
            });
            expect(prisma.probeExecution.create).toHaveBeenCalledTimes(2);
            expect(prisma.probeExecution.create).toHaveBeenNthCalledWith(1, {
                data: expect.objectContaining({
                    probeId: 'probe-1',
                    monitorId: 'monitor-1',
                    target: 'https://api.example.com/health',
                    trigger: 'CALLBACK',
                    status: 'FAILED',
                    success: false,
                    latency: 30,
                    error: 'boom',
                    responseMeta: {
                        applied: true,
                        status: 'DOWN',
                        changed: true,
                    },
                }),
            });
            expect(prisma.probeExecution.create).toHaveBeenNthCalledWith(2, {
                data: expect.objectContaining({
                    probeId: 'probe-1',
                    monitorId: null,
                    target: 'https://unknown.example.com',
                    trigger: 'CALLBACK',
                    status: 'SUCCESS',
                    success: true,
                    latency: 5,
                    error: null,
                    responseMeta: { applied: false },
                }),
            });
        });

        it('collapses duplicated targets before folding them into state', async () => {
            const { service, prisma, checkerService } = createService();
            prisma.probe.findUnique.mockResolvedValue(probeRow);
            prisma.probeResult.createMany.mockResolvedValue({ count: 2 });
            prisma.probe.update.mockResolvedValue(probeRow);
            checkerService.ingestProbeReport.mockResolvedValue({
                monitorId: 'monitor-1',
                status: 'UP',
                changed: false,
            });

            const result = await service.recordResults('secret-1', [
                {
                    target: 'https://api.example.com/health',
                    success: true,
                    latency: 10,
                },
                {
                    target: 'https://api.example.com/health',
                    success: false,
                    latency: 20,
                    error: 'boom',
                },
            ]);

            // Both rows are stored, but the monitor is only folded once and the
            // last report for the target wins.
            expect(result.accepted).toBe(2);
            expect(result.applied).toBe(1);
            expect(checkerService.ingestProbeReport).toHaveBeenCalledTimes(1);
            expect(checkerService.ingestProbeReport).toHaveBeenCalledWith(
                'org-1',
                expect.objectContaining({ success: false, latency: 20 }),
            );
            expect(prisma.probeExecution.create).toHaveBeenCalledTimes(1);
        });

        it('rebalances when a system probe reports before its first heartbeat', async () => {
            const { service, prisma, systemProbeScheduler } = createService();
            prisma.probe.findUnique.mockResolvedValue({
                ...probeRow,
                organizationId: null,
                scope: 'SYSTEM',
                secret: 'sys_secret',
                status: 'OFFLINE',
            });
            prisma.probeResult.createMany.mockResolvedValue({ count: 1 });
            prisma.probe.update.mockResolvedValue(probeRow);
            systemProbeScheduler.getAssignedMonitorIds.mockResolvedValue([]);

            await service.recordResults('sys_secret', [
                {
                    target: 'https://api.example.com/health',
                    success: true,
                    latency: 12,
                },
            ]);

            expect(systemProbeScheduler.rebalance).toHaveBeenCalledTimes(1);
        });

        it('applies system probe results only to assigned monitors', async () => {
            const { service, prisma, checkerService, systemProbeScheduler } =
                createService();
            prisma.probe.findUnique.mockResolvedValue({
                ...probeRow,
                organizationId: null,
                scope: 'SYSTEM',
                secret: 'sys_secret',
            });
            prisma.probeResult.createMany.mockResolvedValue({ count: 1 });
            prisma.probe.update.mockResolvedValue(probeRow);
            systemProbeScheduler.getAssignedMonitorIds.mockResolvedValue([
                'monitor-1',
            ]);
            prisma.monitor.findFirst.mockResolvedValue({ id: 'monitor-1' });
            checkerService.ingestProbeReportForMonitor.mockResolvedValue({
                monitorId: 'monitor-1',
                status: 'UP',
                changed: false,
            });

            const result = await service.recordResults('sys_secret', [
                {
                    target: 'https://api.example.com/health',
                    success: true,
                    latency: 20,
                },
            ]);

            expect(prisma.monitor.findFirst).toHaveBeenCalledWith({
                where: {
                    id: { in: ['monitor-1'] },
                    target: 'https://api.example.com/health',
                    enabled: true,
                    deletedAt: null,
                },
                select: { id: true },
            });
            expect(
                checkerService.ingestProbeReportForMonitor,
            ).toHaveBeenCalledWith(
                'monitor-1',
                expect.objectContaining({
                    target: 'https://api.example.com/health',
                    success: true,
                }),
            );
            expect(result).toEqual({
                accepted: 1,
                applied: 1,
                outcomes: [
                    {
                        target: 'https://api.example.com/health',
                        monitorId: 'monitor-1',
                        status: 'UP',
                        changed: false,
                    },
                ],
            });
        });
    });

    describe('listExecutions', () => {
        it('paginates tenant probe execution logs', async () => {
            const { service, prisma } = createService();
            prisma.probe.findFirst.mockResolvedValue(probeRow);
            prisma.probeExecution.findMany.mockResolvedValue([
                {
                    id: 'execution-1',
                    probeId: 'probe-1',
                    monitorId: 'monitor-1',
                    target: 'https://api.example.com/health',
                    trigger: 'CALLBACK',
                    status: 'SUCCESS',
                    success: true,
                    latency: 12,
                    error: null,
                    requestMeta: {},
                    responseMeta: {},
                    executedAt: new Date('2026-03-05T12:00:00.000Z'),
                },
            ]);
            prisma.probeExecution.count.mockResolvedValue(1);

            const result = await service.listExecutions('org-1', 'probe-1', {
                trigger: 'CALLBACK',
                status: 'SUCCESS',
                page: 2,
                limit: 10,
            });

            expect(prisma.probe.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        id: 'probe-1',
                        organizationId: 'org-1',
                        scope: 'TENANT',
                    },
                }),
            );
            expect(prisma.probeExecution.findMany).toHaveBeenCalledWith({
                where: {
                    probeId: 'probe-1',
                    trigger: 'CALLBACK',
                    status: 'SUCCESS',
                },
                orderBy: { executedAt: 'desc' },
                skip: 10,
                take: 10,
            });
            expect(result.meta).toEqual({
                total: 1,
                page: 2,
                limit: 10,
                totalPages: 1,
            });
            expect(result.data[0].id).toBe('execution-1');
        });
    });

    describe('bindMonitors', () => {
        it('rejects monitors from another organization', async () => {
            const { service, prisma } = createService();
            prisma.probe.findFirst.mockResolvedValue(probeRow);
            prisma.monitor.findMany.mockResolvedValue([{ id: 'monitor-1' }]);

            await expect(
                service.bindMonitors('org-1', 'probe-1', {
                    monitorIds: ['monitor-1', 'monitor-2'],
                }),
            ).rejects.toThrow(BadRequestException);
            expect(prisma.monitorProbe.createMany).not.toHaveBeenCalled();
        });

        it('attaches the monitors and returns the probe', async () => {
            const { service, prisma } = createService();
            prisma.probe.findFirst
                .mockResolvedValueOnce(probeRow)
                .mockResolvedValueOnce({
                    ...probeRow,
                    monitors: [{ monitor: monitorSummary }],
                    _count: { results: 0 },
                });
            prisma.monitor.findMany.mockResolvedValue([{ id: 'monitor-1' }]);
            prisma.monitorProbe.createMany.mockResolvedValue({ count: 1 });

            const result = await service.bindMonitors('org-1', 'probe-1', {
                monitorIds: ['monitor-1'],
            });

            expect(prisma.monitorProbe.createMany).toHaveBeenCalledWith({
                data: [{ monitorId: 'monitor-1', probeId: 'probe-1' }],
                skipDuplicates: true,
            });
            expect(result.monitors).toEqual([
                {
                    id: 'monitor-1',
                    name: 'Production API',
                    type: 'HTTP',
                    target: 'https://api.example.com/health',
                    enabled: true,
                },
            ]);
        });
    });

    describe('unbindMonitor', () => {
        it('throws when the monitor is not attached', async () => {
            const { service, prisma } = createService();
            prisma.probe.findFirst.mockResolvedValue(probeRow);
            prisma.monitorProbe.findUnique.mockResolvedValue(null);

            await expect(
                service.unbindMonitor('org-1', 'probe-1', 'monitor-1'),
            ).rejects.toThrow(NotFoundException);
        });

        it('detaches an attached monitor', async () => {
            const { service, prisma } = createService();
            prisma.probe.findFirst
                .mockResolvedValueOnce(probeRow)
                .mockResolvedValueOnce({ ...probeRow, monitors: [] });
            prisma.monitorProbe.findUnique.mockResolvedValue({
                monitorId: 'monitor-1',
                probeId: 'probe-1',
            });
            prisma.monitorProbe.delete.mockResolvedValue({});

            await service.unbindMonitor('org-1', 'probe-1', 'monitor-1');

            expect(prisma.monitorProbe.delete).toHaveBeenCalledWith({
                where: {
                    monitorId_probeId: {
                        monitorId: 'monitor-1',
                        probeId: 'probe-1',
                    },
                },
            });
        });
    });

    describe('markStaleProbesOffline', () => {
        it('flips probes that stayed silent past the configured threshold', async () => {
            const { service, prisma } = createService();
            const now = Date.now();
            prisma.probe.findMany.mockResolvedValue([
                {
                    id: 'probe-stale',
                    lastHeartbeat: new Date(now - 10 * 60 * 1000),
                    heartbeatIntervalSeconds: null,
                },
                {
                    id: 'probe-fresh',
                    lastHeartbeat: new Date(now - 30 * 1000),
                    heartbeatIntervalSeconds: null,
                },
            ]);
            prisma.probe.updateMany.mockResolvedValue({ count: 1 });

            const count = await service.markStaleProbesOffline();

            expect(count).toBe(1);
            expect(prisma.probe.updateMany).toHaveBeenCalledWith({
                where: { id: { in: ['probe-stale'] }, status: 'ONLINE' },
                data: { status: 'OFFLINE' },
            });
        });

        it('waits three reported intervals for a slow probe', async () => {
            const { service, prisma } = createService();
            const now = Date.now();
            // 300s cadence -> 15 min threshold, so 10 min of silence is fine.
            prisma.probe.findMany.mockResolvedValue([
                {
                    id: 'probe-slow',
                    lastHeartbeat: new Date(now - 10 * 60 * 1000),
                    heartbeatIntervalSeconds: 300,
                },
            ]);

            const count = await service.markStaleProbesOffline();

            expect(count).toBe(0);
            expect(prisma.probe.updateMany).not.toHaveBeenCalled();
        });

        it('treats a probe that never reported a heartbeat as stale', async () => {
            const { service, prisma } = createService();
            prisma.probe.findMany.mockResolvedValue([
                {
                    id: 'probe-silent',
                    lastHeartbeat: null,
                    heartbeatIntervalSeconds: null,
                },
            ]);
            prisma.probe.updateMany.mockResolvedValue({ count: 1 });

            const count = await service.markStaleProbesOffline();

            expect(count).toBe(1);
            expect(prisma.probe.updateMany).toHaveBeenCalledWith({
                where: { id: { in: ['probe-silent'] }, status: 'ONLINE' },
                data: { status: 'OFFLINE' },
            });
        });
    });

    describe('tenant scoping', () => {
        it('throws when the probe is not in the organization', async () => {
            const { service, prisma } = createService();
            prisma.probe.findFirst.mockResolvedValue(null);

            await expect(service.findOne('org-1', 'probe-1')).rejects.toThrow(
                NotFoundException,
            );
            expect(prisma.probe.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        id: 'probe-1',
                        organizationId: 'org-1',
                        scope: 'TENANT',
                    },
                }),
            );
        });
    });
});
