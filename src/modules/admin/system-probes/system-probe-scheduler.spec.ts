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

const basePolicy = {
    allowedMonitorTypes: ['HTTP', 'TCP'],
    minInterval: 10,
    maxProbes: 10,
    maxProbesPerMonitor: 0,
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
    const quotaService = {
        getMonitorPolicy: jest.fn().mockResolvedValue(basePolicy),
    };
    const store = new SystemProbeAssignmentStore(redisService as never);
    const scheduler = new SystemProbeScheduler(
        prisma as unknown as PrismaService,
        store,
        redisService as never,
        { register: jest.fn() } as never,
        quotaService as never,
    );

    return { scheduler, prisma, redisService, quotaService };
}

describe('SystemProbeScheduler', () => {
    it('reserves scarce system-probe capacity for retained monitors', async () => {
        const { scheduler, prisma, quotaService } = createScheduler();
        quotaService.getMonitorPolicy.mockResolvedValue({
            ...basePolicy,
            maxProbesPerMonitor: 1,
            capacityRestrictedIds: ['excluded'],
        });
        prisma.probe.findMany.mockResolvedValue([
            { ...baseProbe, id: 'probe', maxTenants: 1 },
        ]);
        prisma.monitor.findMany.mockResolvedValue([
            { id: 'excluded', type: 'HTTP', organizationId: 'org' },
            { id: 'retained', type: 'HTTP', organizationId: 'org' },
        ]);
        expect(await scheduler.rebalance()).toEqual({ probe: ['retained'] });
    });
    it('assigns N least-loaded system probes to every HTTP/TCP monitor', async () => {
        const { scheduler, prisma, redisService, quotaService } =
            createScheduler();
        quotaService.getMonitorPolicy.mockResolvedValue({
            ...basePolicy,
            maxProbesPerMonitor: 2,
        });
        prisma.probe.findMany.mockResolvedValue([
            { ...baseProbe, id: 'system-a', priority: 10, maxTenants: 0 },
            { ...baseProbe, id: 'system-b', priority: 5, maxTenants: 0 },
            { ...baseProbe, id: 'system-c', priority: 1, maxTenants: 0 },
        ]);
        prisma.monitor.findMany.mockResolvedValue([
            { id: 'monitor-1', type: 'HTTP', organizationId: 'org-1' },
            { id: 'local-dns', type: 'DNS', organizationId: 'org-1' },
            { id: 'local-ping', type: 'PING', organizationId: 'org-1' },
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
            'system-b': ['monitor-1'],
            'system-c': [],
        });
        expect(redisService.setJson).toHaveBeenCalledWith(
            'sys_probe:assignments',
            assignments,
            3600,
        );
        redisService.getJson.mockResolvedValue(assignments);
        await expect(scheduler.getAssignedProbes('monitor-1')).resolves.toEqual(
            ['system-a', 'system-b'],
        );
    });

    it('assigns nothing when the plan includes no system probe', async () => {
        const { scheduler, prisma } = createScheduler();
        prisma.probe.findMany.mockResolvedValue([
            { ...baseProbe, id: 'system-a', priority: 10, maxTenants: 0 },
        ]);
        prisma.monitor.findMany.mockResolvedValue([
            { id: 'monitor-1', type: 'HTTP', organizationId: 'org-1' },
        ]);

        const assignments = await scheduler.rebalance();

        expect(assignments).toEqual({ 'system-a': [] });
    });

    it('skips monitors that judge on tenant probes only', async () => {
        const { scheduler, prisma, quotaService } = createScheduler();
        quotaService.getMonitorPolicy.mockResolvedValue({
            ...basePolicy,
            maxProbesPerMonitor: 2,
        });
        prisma.probe.findMany.mockResolvedValue([
            { ...baseProbe, id: 'system-a', priority: 10, maxTenants: 0 },
        ]);
        prisma.monitor.findMany.mockResolvedValue([
            {
                id: 'monitor-tenant-only',
                type: 'HTTP',
                organizationId: 'org-1',
                tenantProbesOnly: true,
            },
            {
                id: 'monitor-pool',
                type: 'HTTP',
                organizationId: 'org-1',
                tenantProbesOnly: false,
            },
        ]);

        const assignments = await scheduler.rebalance();

        expect(assignments).toEqual({ 'system-a': ['monitor-pool'] });
    });

    it('spreads monitors over probes without exceeding maxTenants', async () => {
        const { scheduler, prisma, quotaService } = createScheduler();
        quotaService.getMonitorPolicy.mockResolvedValue({
            ...basePolicy,
            maxProbesPerMonitor: 2,
        });
        prisma.probe.findMany.mockResolvedValue([
            { ...baseProbe, id: 'system-a', priority: 10, maxTenants: 1 },
            { ...baseProbe, id: 'system-b', priority: 5, maxTenants: 0 },
        ]);
        prisma.monitor.findMany.mockResolvedValue([
            { id: 'monitor-1', type: 'HTTP', organizationId: 'org-1' },
            { id: 'monitor-2', type: 'TCP', organizationId: 'org-1' },
        ]);

        const assignments = await scheduler.rebalance();

        expect(assignments).toEqual({
            'system-a': ['monitor-1'],
            'system-b': ['monitor-1', 'monitor-2'],
        });
    });

    it('reads the plan of each organization', async () => {
        const { scheduler, prisma, quotaService } = createScheduler();
        quotaService.getMonitorPolicy.mockImplementation((organizationId) =>
            Promise.resolve({
                ...basePolicy,
                maxProbesPerMonitor: organizationId === 'org-pro' ? 1 : 0,
            }),
        );
        prisma.probe.findMany.mockResolvedValue([
            { ...baseProbe, id: 'system-a', priority: 10, maxTenants: 0 },
        ]);
        prisma.monitor.findMany.mockResolvedValue([
            { id: 'monitor-pro', type: 'HTTP', organizationId: 'org-pro' },
            { id: 'monitor-free', type: 'HTTP', organizationId: 'org-free' },
        ]);

        const assignments = await scheduler.rebalance();

        expect(quotaService.getMonitorPolicy).toHaveBeenCalledWith('org-pro');
        expect(quotaService.getMonitorPolicy).toHaveBeenCalledWith('org-free');
        expect(assignments).toEqual({ 'system-a': ['monitor-pro'] });
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
