import {
    BadRequestException,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { ProbesService } from './probes.service';
import type { PrismaService } from '../../database/prisma.service';
import type { CheckerService } from '../checker/checker.service';

const probeRow = {
    id: 'probe-1',
    organizationId: 'org-1',
    name: 'Tokyo probe',
    provider: 'TENCENT',
    region: 'ap-northeast-1',
    callbackUrl: 'https://probe.example.com/callback',
    secret: 'secret-1',
    enabled: true,
    lastHeartbeat: null,
    status: 'OFFLINE',
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
        monitorProbe: {
            createMany: jest.fn(),
            findUnique: jest.fn(),
            delete: jest.fn(),
        },
        monitor: { findMany: jest.fn() },
    };
    const checkerService = { ingestProbeReport: jest.fn() };

    const service = new ProbesService(
        prisma as unknown as PrismaService,
        checkerService as unknown as CheckerService,
    );

    return { service, prisma, checkerService };
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
            expect(created.data.secret).toMatch(/^[0-9a-f]{64}$/);
            expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
            expect(result.monitors).toEqual([]);
        });
    });

    describe('recordHeartbeat', () => {
        it('marks the probe online and returns the monitors to check', async () => {
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
        it('flips silent probes offline', async () => {
            const { service, prisma } = createService();
            prisma.probe.updateMany.mockResolvedValue({ count: 2 });

            const count = await service.markStaleProbesOffline();

            expect(count).toBe(2);
            expect(prisma.probe.updateMany).toHaveBeenCalledWith({
                where: {
                    status: 'ONLINE',
                    OR: [
                        { lastHeartbeat: null },
                        { lastHeartbeat: { lt: expect.any(Date) } },
                    ],
                },
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
        });
    });
});
