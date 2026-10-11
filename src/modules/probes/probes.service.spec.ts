import {
    BadRequestException,
    ForbiddenException,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { ProbesService } from './probes.service';
import { hashSecret } from './probe-secret.util';
import type { PrismaService } from '../../infra/database/prisma.service';
import type { CheckerService } from '../checker/checker.service';

const RAW_SECRET = 'secret-1';

interface ProbeStub {
    id: string;
    organizationId: string | null;
    scope: string;
    name: string;
    provider: string;
    region: string;
    callbackUrl: string;
    enabled: boolean;
    lastHeartbeat: Date | null;
    status: string;
    maxTenants: number;
    priority: number;
    createdAt: Date;
    updatedAt: Date;
}

const probeRow: ProbeStub = {
    id: 'probe-1',
    organizationId: 'org-1',
    scope: 'TENANT',
    name: 'Tokyo probe',
    provider: 'TENCENT',
    region: 'ap-northeast-1',
    callbackUrl: 'https://probe.example.com/callback',
    enabled: true,
    lastHeartbeat: null,
    status: 'OFFLINE',
    maxTenants: 0,
    priority: 0,
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
};

/** A credential row as `probeSecret.findUnique` returns it. */
function secretMatch(probe: ProbeStub = probeRow) {
    return {
        id: 'secret-1',
        probeId: probe.id,
        secretHash: hashSecret(RAW_SECRET),
        revokedAt: null as Date | null,
        expiresAt: null as Date | null,
        probe,
    };
}

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
            findMany: jest.fn().mockResolvedValue([]),
            count: jest.fn(),
            createMany: jest.fn(),
            create: jest.fn(),
            findUnique: jest.fn(),
            findUniqueOrThrow: jest.fn(),
            update: jest.fn(),
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
        monitor: {
            findMany: jest.fn(),
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            findUniqueOrThrow: jest.fn(),
        },
        probeSecret: {
            findUnique: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        $transaction: jest.fn(),
        $queryRaw: jest.fn(),
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
            // Stored as a hash, never the plaintext secret.
            expect(created.data.secrets.create.secretHash).toMatch(
                /^[0-9a-f]{64}$/,
            );
            expect(created.data.secrets.create.secretPrefix).toMatch(
                /^tnt_[0-9a-f]{8}$/,
            );
            expect(result.secret).toMatch(/^tnt_[0-9a-f]{64}$/);
            expect(result.monitors).toEqual([]);
        });
    });

    describe('recordHeartbeat', () => {
        it('marks a tenant probe online and returns directly bound monitors', async () => {
            const { service, prisma } = createService();
            prisma.probeSecret.findUnique.mockResolvedValue(secretMatch());
            prisma.probe.update.mockResolvedValue({
                ...probeRow,
                status: 'ONLINE',
                lastHeartbeat: new Date('2026-03-05T12:00:00.000Z'),
                monitors: [
                    { monitor: monitorSummary },
                    {
                        monitor: {
                            ...monitorSummary,
                            id: 'local-dns',
                            type: 'DNS',
                        },
                    },
                    {
                        monitor: {
                            ...monitorSummary,
                            id: 'local-ping',
                            type: 'PING',
                        },
                    },
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

            expect(prisma.probeSecret.findUnique).toHaveBeenCalledWith({
                where: { secretHash: hashSecret('secret-1') },
                include: { probe: true },
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
            prisma.probeSecret.findUnique.mockResolvedValue(
                secretMatch({
                    ...probeRow,
                    organizationId: null,
                    scope: 'SYSTEM',
                }),
            );
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
            prisma.probeSecret.findUnique.mockResolvedValue(
                secretMatch({
                    ...probeRow,
                    organizationId: null,
                    scope: 'SYSTEM',
                    status: 'ONLINE',
                }),
            );
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
            expect(prisma.probeSecret.findUnique).not.toHaveBeenCalled();
        });

        it('rejects an unknown secret', async () => {
            const { service, prisma } = createService();
            prisma.probeSecret.findUnique.mockResolvedValue(null);

            await expect(service.recordHeartbeat('nope')).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it('rejects a disabled probe', async () => {
            const { service, prisma } = createService();
            prisma.probeSecret.findUnique.mockResolvedValue(
                secretMatch({ ...probeRow, enabled: false }),
            );

            await expect(service.recordHeartbeat('secret-1')).rejects.toThrow(
                UnauthorizedException,
            );
        });
    });

    describe('recordResults', () => {
        it('stores authorized attributed results before applying the durable ingest', async () => {
            const { service, prisma, checkerService } = createService();
            prisma.probeSecret.findUnique.mockResolvedValue(secretMatch());
            const m = {
                ...monitorSummary,
                organizationId: 'org-1',
                projectId: 'project-1',
                configRevision: 1,
                updatedAt: new Date(0),
            };
            prisma.monitor.findMany.mockResolvedValue([m]);
            prisma.monitor.findUniqueOrThrow.mockResolvedValue(m);
            prisma.monitor.findUnique.mockResolvedValue(m);
            prisma.monitorProbe.findUnique.mockResolvedValue({});
            prisma.$transaction.mockImplementation(
                (callback: (tx: unknown) => unknown) => callback(prisma),
            );
            prisma.probeResult.create.mockImplementation(({ data }) => ({
                ...data,
                id: 'raw-1',
                appliedAt: null,
            }));
            prisma.probeResult.findUniqueOrThrow.mockImplementation(() => ({
                ...prisma.probeResult.create.mock.calls[0][0].data,
                id: 'raw-1',
                appliedAt: null,
            }));
            prisma.probe.update.mockResolvedValue(probeRow);
            checkerService.ingestProbeReportForMonitor.mockResolvedValue({
                monitorId: 'monitor-1',
                status: 'DOWN',
                changed: true,
            });

            const result = await service.recordResults('secret-1', [
                {
                    target: 'https://api.example.com/health',
                    success: false,
                    latency: 30,
                    error: 'boom',
                    checkedAt: new Date().toISOString(),
                    monitorId: m.id,
                    reportId: 'report-1',
                    configRevision: 1,
                },
            ]);

            expect(prisma.probeResult.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    probeId: 'probe-1',
                    monitorId: m.id,
                    projectId: 'project-1',
                    organizationId: 'org-1',
                    configRevision: 1,
                    reportId: 'report-1',
                }),
            });
            expect(
                checkerService.ingestProbeReportForMonitor,
            ).toHaveBeenCalledWith(
                'monitor-1',
                expect.objectContaining({
                    target: 'https://api.example.com/health',
                    success: false,
                }),
            );
            expect(result).toEqual({
                accepted: 1,
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
            expect(prisma.probeResult.update).toHaveBeenCalledWith({
                where: { id: 'raw-1' },
                data: { appliedAt: expect.any(Date) },
            });
        });

        it('rejects ambiguous legacy targets instead of collapsing different monitor IDs', async () => {
            const { service, prisma, checkerService } = createService();
            prisma.probeSecret.findUnique.mockResolvedValue(secretMatch());
            prisma.monitor.findMany.mockResolvedValue([
                monitorSummary,
                { ...monitorSummary, id: 'monitor-2' },
            ]);
            await expect(
                service.recordResults('secret-1', [
                    {
                        target: 'https://api.example.com/health',
                        success: true,
                        latency: 10,
                        checkedAt: new Date().toISOString(),
                    },
                ]),
            ).rejects.toThrow(ForbiddenException);
            expect(prisma.probeResult.create).not.toHaveBeenCalled();
            expect(
                checkerService.ingestProbeReportForMonitor,
            ).not.toHaveBeenCalled();
        });

        it('rejects unassigned system reports before storing raw data', async () => {
            const { service, prisma, systemProbeScheduler } = createService();
            prisma.probeSecret.findUnique.mockResolvedValue(
                secretMatch({
                    ...probeRow,
                    organizationId: null,
                    scope: 'SYSTEM',
                    status: 'OFFLINE',
                }),
            );
            systemProbeScheduler.getAssignedMonitorIds.mockResolvedValue([]);
            prisma.monitor.findMany.mockResolvedValue([]);

            await expect(
                service.recordResults('sys_secret', [
                    {
                        target: 'https://api.example.com/health',
                        success: true,
                        latency: 12,
                        checkedAt: new Date().toISOString(),
                    },
                ]),
            ).rejects.toThrow(ForbiddenException);
            expect(prisma.probeResult.create).not.toHaveBeenCalled();
        });

        it('requires checkedAt even for assigned system monitors', async () => {
            const { service, prisma, systemProbeScheduler } = createService();
            prisma.probeSecret.findUnique.mockResolvedValue(
                secretMatch({
                    ...probeRow,
                    organizationId: null,
                    scope: 'SYSTEM',
                }),
            );
            systemProbeScheduler.getAssignedMonitorIds.mockResolvedValue([
                'monitor-1',
            ]);
            prisma.monitor.findMany.mockResolvedValue([monitorSummary]);

            await expect(
                service.recordResults('sys_secret', [
                    {
                        target: 'https://api.example.com/health',
                        success: true,
                        latency: 20,
                    },
                ]),
            ).rejects.toThrow(BadRequestException);
            expect(prisma.monitor.findMany).toHaveBeenCalledWith({
                where: {
                    id: { in: ['monitor-1'] },
                    enabled: true,
                    deletedAt: null,
                    project: {
                        deletedAt: null,
                        organization: { deletedAt: null },
                    },
                },
            });
            expect(prisma.probeResult.create).not.toHaveBeenCalled();
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
