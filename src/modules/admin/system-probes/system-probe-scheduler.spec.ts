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
    };
    const store = new SystemProbeAssignmentStore(redisService as never);
    const scheduler = new SystemProbeScheduler(
        prisma as unknown as PrismaService,
        store,
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
            { id: 'monitor-1', probes: [] },
            {
                id: 'monitor-2',
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
        expect(redisService.del).toHaveBeenCalledWith('sys_probe:assignments');
        await expect(scheduler.getAssignedProbes('monitor-1')).resolves.toEqual(
            [],
        );
    });
});
