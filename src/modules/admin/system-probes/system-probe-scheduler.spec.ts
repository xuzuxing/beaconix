import type { PrismaService } from '../../../infra/database/prisma.service';
import { SystemProbeAssignmentStore } from './system-probe-assignment.store';
import { SystemProbeScheduler } from './system-probe-scheduler';

const baseProbe = {
    organizationId: null,
    scope: 'SYSTEM',
    name: 'System probe',
    provider: 'TENCENT',
    region: 'ap-northeast-1',
    callbackUrl: 'https://probe.example.com/callback',
    secret: 'secret',
    enabled: true,
    lastHeartbeat: new Date('2026-03-05T12:00:00.000Z'),
    status: 'ONLINE',
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
};

function createScheduler() {
    const prisma = {
        probe: { findMany: jest.fn() },
        monitor: { findMany: jest.fn() },
    };
    const redisService = {
        getJson: jest.fn(),
        setJson: jest.fn(),
        del: jest.fn(),
        setIfAbsent: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(true),
    };
    const store = new SystemProbeAssignmentStore(redisService as never);
    const scheduler = new SystemProbeScheduler(
        prisma as unknown as PrismaService,
        store,
        redisService as never,
        { register: jest.fn() } as never,
    );

    return { scheduler, prisma, redisService };
}

describe('SystemProbeScheduler', () => {
    it('assigns system probes only to monitors with fewer than two active tenant probes', async () => {
        const { scheduler, prisma, redisService } = createScheduler();
        prisma.probe.findMany.mockResolvedValue([
            { ...baseProbe, id: 'system-a', priority: 10, maxTenants: 2 },
            { ...baseProbe, id: 'system-b', priority: 5, maxTenants: 0 },
        ]);
        prisma.monitor.findMany.mockResolvedValue([
            { id: 'monitor-1', type: 'HTTP', probes: [] },
            { id: 'local-dns', type: 'DNS', probes: [] },
            { id: 'local-ping', type: 'PING', probes: [] },
            {
                id: 'monitor-2',
                type: 'TCP',
                probes: [
                    {
                        probe: {
                            id: 'tenant-1',
                            scope: 'TENANT',
                            enabled: true,
                            status: 'ONLINE',
                        },
                    },
                ],
            },
            {
                id: 'monitor-3',
                type: 'HTTP',
                probes: [
                    {
                        probe: {
                            id: 'tenant-2',
                            scope: 'TENANT',
                            enabled: true,
                            status: 'ONLINE',
                        },
                    },
                    {
                        probe: {
                            id: 'tenant-3',
                            scope: 'TENANT',
                            enabled: true,
                            status: 'ONLINE',
                        },
                    },
                ],
            },
        ]);

        const assignments = await scheduler.rebalance();

        expect(prisma.probe.findMany).toHaveBeenCalledWith({
            where: {
                scope: 'SYSTEM',
                enabled: true,
                status: 'ONLINE',
            },
            orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        });
        expect(assignments).toEqual({
            'system-a': ['monitor-1'],
            'system-b': ['monitor-2'],
        });
        expect(redisService.setJson).toHaveBeenCalledWith(
            'sys_probe:assignments',
            assignments,
            3600,
        );
        redisService.getJson.mockResolvedValue(assignments);
        await expect(scheduler.getAssignedProbes('monitor-1')).resolves.toEqual(
            ['system-a'],
        );
    });

    it('clears assignments when no online system probes are available', async () => {
        const { scheduler, prisma, redisService } = createScheduler();
        prisma.probe.findMany.mockResolvedValue([]);

        const assignments = await scheduler.rebalance();

        expect(assignments).toEqual({});
        expect(redisService.setJson).toHaveBeenCalledWith(
            'sys_probe:assignments',
            {},
            3600,
        );
        await expect(scheduler.getAssignedProbes('monitor-1')).resolves.toEqual(
            [],
        );
    });

    it('serves reads from the cached table without rebalancing', async () => {
        const { scheduler, prisma, redisService } = createScheduler();
        redisService.getJson.mockResolvedValue({
            'system-a': ['monitor-1'],
        });

        await expect(
            scheduler.getAssignedMonitorIds('system-a'),
        ).resolves.toEqual(['monitor-1']);
        await expect(scheduler.getAssignedProbes('monitor-1')).resolves.toEqual(
            ['system-a'],
        );
        expect(prisma.monitor.findMany).not.toHaveBeenCalled();
    });

    it('skips the recompute while another instance holds the lock', async () => {
        const { scheduler, prisma, redisService } = createScheduler();
        redisService.setIfAbsent.mockResolvedValue(false);
        redisService.getJson.mockResolvedValue({ 'system-a': ['monitor-1'] });

        const assignments = await scheduler.rebalance();

        expect(assignments).toEqual({ 'system-a': ['monitor-1'] });
        expect(prisma.probe.findMany).not.toHaveBeenCalled();
        expect(redisService.releaseLock).not.toHaveBeenCalled();
    });

    it('releases the lock after computing', async () => {
        const { scheduler, prisma, redisService } = createScheduler();
        prisma.probe.findMany.mockResolvedValue([]);

        await scheduler.rebalance();

        expect(redisService.setIfAbsent).toHaveBeenCalledWith(
            'sys_probe:rebalance:lock',
            expect.any(String),
            30,
        );
        expect(redisService.releaseLock).toHaveBeenCalledWith(
            'sys_probe:rebalance:lock',
            expect.any(String),
        );
    });
});
