import { AdminMetricsService } from './admin-metrics.service';
import type { PrismaService } from '../../../infra/database/prisma.service';

function createService() {
    const prisma = {
        organization: { findMany: jest.fn() },
        monitor: { findMany: jest.fn() },
        probe: { findMany: jest.fn(), count: jest.fn() },
        statusPage: { findMany: jest.fn() },
        checkLog: { groupBy: jest.fn() },
        notificationLog: { groupBy: jest.fn() },
        notificationChannel: { findMany: jest.fn() },
        user: { count: jest.fn() },
        project: { count: jest.fn() },
    };

    const service = new AdminMetricsService(prisma as unknown as PrismaService);

    return { service, prisma };
}

describe('AdminMetricsService', () => {
    it('builds per-tenant usage metrics', async () => {
        const { service, prisma } = createService();
        prisma.organization.findMany.mockResolvedValue([
            {
                id: 'org-1',
                name: 'Acme',
                slug: 'acme',
                deletedAt: null,
            },
            {
                id: 'org-2',
                name: 'Globex',
                slug: 'globex',
                deletedAt: new Date('2026-03-06T12:00:00.000Z'),
            },
        ]);
        prisma.monitor.findMany.mockResolvedValue([
            {
                id: 'monitor-1',
                organizationId: 'org-1',
                enabled: true,
                deletedAt: null,
                probes: [
                    {
                        probe: {
                            scope: 'TENANT',
                            enabled: true,
                            status: 'ONLINE',
                        },
                    },
                ],
            },
            {
                id: 'monitor-2',
                organizationId: 'org-1',
                enabled: true,
                deletedAt: null,
                probes: [
                    {
                        probe: {
                            scope: 'TENANT',
                            enabled: true,
                            status: 'ONLINE',
                        },
                    },
                    {
                        probe: {
                            scope: 'TENANT',
                            enabled: true,
                            status: 'ONLINE',
                        },
                    },
                ],
            },
            {
                id: 'monitor-3',
                organizationId: 'org-2',
                enabled: false,
                deletedAt: null,
                probes: [],
            },
        ]);
        prisma.probe.findMany.mockResolvedValue([
            { id: 'probe-1', organizationId: 'org-1', scope: 'TENANT' },
            { id: 'probe-2', organizationId: null, scope: 'SYSTEM' },
        ]);
        prisma.statusPage.findMany.mockResolvedValue([
            { id: 'page-1', organizationId: 'org-1' },
        ]);
        prisma.checkLog.groupBy.mockResolvedValue([
            { monitorId: 'monitor-1', _count: 10 },
            { monitorId: 'monitor-2', _count: 5 },
        ]);
        prisma.notificationLog.groupBy.mockResolvedValue([
            { channelId: 'channel-1', _count: 7 },
        ]);
        prisma.notificationChannel.findMany.mockResolvedValue([
            { id: 'channel-1', organizationId: 'org-1' },
        ]);

        const result = await service.getTenantMetrics();

        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({
            organizationId: 'org-1',
            active: true,
            monitorCount: 2,
            enabledMonitorCount: 2,
            tenantProbeCount: 1,
            systemProbeUsage: 1,
            checkVolume: 15,
            notificationVolume: 7,
            statusPageCount: 1,
        });
        expect(result[1]).toMatchObject({
            organizationId: 'org-2',
            active: false,
            monitorCount: 1,
            enabledMonitorCount: 0,
            tenantProbeCount: 0,
            systemProbeUsage: 0,
            checkVolume: 0,
            notificationVolume: 0,
            statusPageCount: 0,
        });
    });

    it('aggregates tenant metrics into the platform overview', async () => {
        const { service, prisma } = createService();
        prisma.organization.findMany.mockResolvedValue([
            {
                id: 'org-1',
                name: 'Acme',
                slug: 'acme',
                deletedAt: null,
            },
        ]);
        prisma.monitor.findMany.mockResolvedValue([]);
        prisma.probe.findMany.mockResolvedValue([]);
        prisma.statusPage.findMany.mockResolvedValue([]);
        prisma.checkLog.groupBy.mockResolvedValue([]);
        prisma.notificationLog.groupBy.mockResolvedValue([]);
        prisma.notificationChannel.findMany.mockResolvedValue([]);
        prisma.user.count.mockResolvedValue(20);
        prisma.project.count.mockResolvedValue(5);
        prisma.probe.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

        const result = await service.getOverview();

        expect(result.tenants).toEqual({ total: 1, active: 1, deleted: 0 });
        expect(result.users).toBe(20);
        expect(result.projects).toBe(5);
        expect(result.probes).toEqual({ total: 2, tenant: 0, system: 1 });
        expect(result.monitors).toEqual({ total: 0, enabled: 0 });
    });
});
