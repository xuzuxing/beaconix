import {
    BadRequestException,
    ConflictException,
    NotFoundException,
} from '@nestjs/common';
import {
    StatusPagesService,
    deriveOverallStatus,
} from './status-pages.service';
import type { PrismaService } from '../../infra/database/prisma.service';

const statusPageRow = {
    id: 'page-1',
    organizationId: 'org-1',
    slug: 'acme-status',
    title: 'Acme status',
    description: null,
    visibleMonitorIds: ['monitor-1'],
    showLatency: true,
    showUptime: false,
    enabled: true,
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
};

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
    state: {
        monitorId: 'monitor-1',
        status: 'DOWN',
        failCount: 3,
        lastCheckAt: new Date('2026-03-05T12:00:00.000Z'),
        lastError: 'connect ECONNREFUSED',
        lastLatency: 30,
        lastNotifiedStatus: null,
        sslExpiresAt: null,
        sslDaysRemaining: null,
        sslIssuer: null,
        sslSubject: null,
        sslLastNotifiedAt: null,
        updatedAt: new Date('2026-03-05T12:00:00.000Z'),
    },
};

function createService() {
    const prisma = {
        statusPage: {
            create: jest.fn(),
            findMany: jest.fn(),
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        },
        monitor: { findMany: jest.fn() },
        checkLog: { count: jest.fn() },
    };
    const billingService = {
        assertFeatureAllowed: jest.fn().mockResolvedValue(undefined),
    };

    const service = new StatusPagesService(
        prisma as unknown as PrismaService,
        billingService as never,
    );

    return { service, prisma, billingService };
}

describe('deriveOverallStatus', () => {
    it('returns UNKNOWN for an empty page', () => {
        expect(deriveOverallStatus([])).toBe('UNKNOWN');
    });

    it('lets DOWN win over DEGRADED and UP', () => {
        expect(deriveOverallStatus(['UP', 'DEGRADED', 'DOWN'])).toBe('DOWN');
    });

    it('returns DEGRADED when no monitor is DOWN', () => {
        expect(deriveOverallStatus(['UP', 'DEGRADED', 'UNKNOWN'])).toBe(
            'DEGRADED',
        );
    });

    it('returns UP only when every monitor is UP', () => {
        expect(deriveOverallStatus(['UP', 'UP'])).toBe('UP');
    });

    it('returns UNKNOWN for a mixed page without DOWN or DEGRADED', () => {
        expect(deriveOverallStatus(['UP', 'UNKNOWN'])).toBe('UNKNOWN');
    });
});

describe('StatusPagesService', () => {
    describe('create', () => {
        it('creates a page with an explicit slug and validates monitors', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findMany.mockResolvedValue([{ id: 'monitor-1' }]);
            prisma.statusPage.findUnique.mockResolvedValue(null);
            prisma.statusPage.create.mockImplementation(({ data }) =>
                Promise.resolve({ ...statusPageRow, ...data }),
            );

            const result = await service.create('org-1', {
                title: 'Acme status',
                slug: 'acme-status',
                visibleMonitorIds: ['monitor-1'],
                showLatency: true,
                showUptime: false,
                enabled: true,
            });

            expect(prisma.monitor.findMany).toHaveBeenCalledWith({
                where: {
                    id: { in: ['monitor-1'] },
                    organizationId: 'org-1',
                    deletedAt: null,
                    project: {
                        organizationId: 'org-1',
                        deletedAt: null,
                        organization: { deletedAt: null },
                    },
                },
                select: { id: true },
            });
            expect(prisma.statusPage.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    organizationId: 'org-1',
                    slug: 'acme-status',
                    title: 'Acme status',
                    visibleMonitorIds: ['monitor-1'],
                }),
            });
            expect(result.slug).toBe('acme-status');
        });

        it('rejects monitors that are not in the organization', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findMany.mockResolvedValue([{ id: 'monitor-1' }]);

            await expect(
                service.create('org-1', {
                    title: 'Acme status',
                    visibleMonitorIds: ['monitor-1', 'monitor-2'],
                }),
            ).rejects.toThrow(BadRequestException);
        });

        it('rejects an already used slug', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findMany.mockResolvedValue([]);
            prisma.statusPage.findUnique.mockResolvedValue({ id: 'other' });

            await expect(
                service.create('org-1', {
                    title: 'Acme status',
                    slug: 'acme-status',
                }),
            ).rejects.toThrow(ConflictException);
        });
    });

    describe('getPublicBySlug', () => {
        it('excludes execution blocks from public uptime', async () => {
            const { service, prisma } = createService();
            prisma.statusPage.findUnique.mockResolvedValue({
                ...statusPageRow,
                showUptime: true,
            });
            prisma.monitor.findMany.mockResolvedValue([monitorRow]);
            prisma.checkLog.count.mockImplementation(({ where }) =>
                Promise.resolve(
                    where.evaluated ? (where.success ? 9 : 10) : 20,
                ),
            );
            const result = await service.getPublicBySlug('acme-status');
            expect(result.monitors[0].uptimePercent).toBe(90);
            expect(prisma.checkLog.count).toHaveBeenCalledWith({
                where: expect.objectContaining({ evaluated: true }),
            });
        });
        it('returns the public page with only visible monitors', async () => {
            const { service, prisma } = createService();
            prisma.statusPage.findUnique.mockResolvedValue(statusPageRow);
            prisma.monitor.findMany.mockResolvedValue([monitorRow]);
            prisma.checkLog.count.mockResolvedValue(0);

            const result = await service.getPublicBySlug('acme-status');

            expect(prisma.monitor.findMany).toHaveBeenCalledWith({
                where: {
                    id: { in: ['monitor-1'] },
                    organizationId: 'org-1',
                    deletedAt: null,
                    project: {
                        organizationId: 'org-1',
                        deletedAt: null,
                        organization: { deletedAt: null },
                    },
                },
                include: { state: true },
                orderBy: { createdAt: 'asc' },
            });
            expect(result.overallStatus).toBe('DOWN');
            expect(result.monitors).toHaveLength(1);
            expect(result.monitors[0].latency).toBe(30);
            expect(result.monitors[0].uptimePercent).toBeUndefined();
        });

        it('hides disabled pages with a not-found error', async () => {
            const { service, prisma } = createService();
            prisma.statusPage.findUnique.mockResolvedValue({
                ...statusPageRow,
                enabled: false,
            });

            await expect(
                service.getPublicBySlug('acme-status'),
            ).rejects.toThrow(NotFoundException);
        });

        it('filters deleted organizations and projects while stripping target credentials', async () => {
            const { service, prisma } = createService();
            prisma.statusPage.findUnique.mockResolvedValue(statusPageRow);
            prisma.monitor.findMany.mockResolvedValue([
                {
                    ...monitorRow,
                    target: 'https://user:password@api.test/health?token=private-secret',
                },
            ]);
            const result = await service.getPublicBySlug('acme-status');
            expect(prisma.statusPage.findUnique).toHaveBeenCalledWith({
                where: {
                    slug: 'acme-status',
                    organization: { deletedAt: null },
                },
            });
            expect(
                prisma.monitor.findMany.mock.calls[0][0].where.project,
            ).toEqual({
                organizationId: 'org-1',
                deletedAt: null,
                organization: { deletedAt: null },
            });
            expect(JSON.stringify(result)).not.toContain('private-secret');
            expect(JSON.stringify(result)).not.toContain('password');
        });
    });
});
