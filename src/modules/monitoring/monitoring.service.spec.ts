import { MonitoringService } from './monitoring.service';
import type { PrismaService } from '../../infra/database/prisma.service';

const monitor = (overrides: Record<string, unknown> = {}) => ({
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
    checkSsl: true,
    sslExpiryThreshold: 30,
    enabled: true,
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
    deletedAt: null,
    state: {
        monitorId: 'monitor-1',
        status: 'DOWN',
        failCount: 3,
        lastCheckAt: new Date('2026-03-05T12:00:00.000Z'),
        lastError: 'connect ECONNREFUSED',
        lastLatency: 30,
        lastNotifiedStatus: null,
        sslExpiresAt: null,
        sslDaysRemaining: 5,
        sslIssuer: null,
        sslSubject: null,
        sslLastNotifiedAt: null,
        updatedAt: new Date('2026-03-05T12:00:00.000Z'),
    },
    ...overrides,
});

function createService() {
    const prisma = {
        monitor: { findMany: jest.fn() },
        checkLog: { count: jest.fn() },
    };

    const service = new MonitoringService(prisma as unknown as PrismaService);

    return { service, prisma };
}

describe('MonitoringService', () => {
    describe('getOrganizationOverview', () => {
        it('queries every monitor in the organization', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findMany.mockResolvedValue([monitor()]);
            prisma.checkLog.count.mockResolvedValue(10);

            await service.getOrganizationOverview('org-1');

            expect(prisma.monitor.findMany).toHaveBeenCalledWith({
                where: { organizationId: 'org-1', deletedAt: null },
                include: { state: true },
                orderBy: { createdAt: 'asc' },
            });
        });

        it('aggregates counts, incidents, latency and SSL expiry', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findMany.mockResolvedValue([
                monitor(),
                monitor({
                    id: 'monitor-2',
                    enabled: false,
                    state: {
                        ...monitor().state,
                        monitorId: 'monitor-2',
                        status: 'PAUSED',
                        lastLatency: 10,
                        sslDaysRemaining: null,
                    },
                }),
            ]);
            prisma.checkLog.count.mockImplementation(({ where }) =>
                Promise.resolve(where.success ? 8 : 10),
            );

            const result = await service.getOrganizationOverview('org-1');

            expect(result.monitors).toEqual({
                total: 2,
                enabled: 1,
                paused: 1,
            });
            expect(result.byStatus).toEqual({
                UNKNOWN: 0,
                UP: 0,
                DEGRADED: 0,
                DOWN: 1,
                PAUSED: 1,
            });
            expect(result.recentIncidents).toHaveLength(1);
            expect(result.recentIncidents[0].id).toBe('monitor-1');
            expect(result.avgLatency).toBe(20);
            expect(result.uptime).toEqual({
                totalChecks: 10,
                successfulChecks: 8,
                uptimePercent: 80,
            });
            expect(result.sslExpiringSoon).toBe(1);
        });

        it('returns zeroed overview when the scope has no monitors', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findMany.mockResolvedValue([]);

            const result = await service.getOrganizationOverview('org-1');

            expect(result.monitors).toEqual({
                total: 0,
                enabled: 0,
                paused: 0,
            });
            expect(result.recentIncidents).toEqual([]);
            expect(result.avgLatency).toBeNull();
            expect(result.uptime).toEqual({
                totalChecks: 0,
                successfulChecks: 0,
                uptimePercent: null,
            });
            expect(result.sslExpiringSoon).toBe(0);
        });
    });

    describe('getProjectOverview', () => {
        it('queries every monitor in the project', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findMany.mockResolvedValue([]);

            await service.getProjectOverview('project-1');

            expect(prisma.monitor.findMany).toHaveBeenCalledWith({
                where: { projectId: 'project-1', deletedAt: null },
                include: { state: true },
                orderBy: { createdAt: 'asc' },
            });
        });
    });
});
