import {
    BadRequestException,
    ConflictException,
    NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
    StatusPagesService,
    deriveOverallStatus,
} from './status-pages.service';
import type { PrismaService } from '../../infra/database/prisma.service';

const AS_OF = new Date('2026-03-05T12:00:00.000Z');

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
    probeSuccessRatio: 1,
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

const monitor = (overrides: Record<string, unknown> = {}) => ({
    ...monitorRow,
    ...overrides,
});

interface Fixture {
    asOf?: Date;
    uptimeRows?: { monitorId: string; checks: number; successes: number }[];
    availabilityRows?: {
        monitorId: string;
        day: string;
        hour: number;
        checks: number;
        successes: number;
    }[];
    coverage?: { projectId: string; checksStartedAt: Date }[];
}

/** Raw SQL text of a `$queryRaw` call, whichever calling form was used. */
function sqlOf(call: unknown[]): string {
    const [first, ...values] = call;
    return Array.isArray(first)
        ? Prisma.sql(first, ...values).sql
        : (first as Prisma.Sql).sql;
}

function createService(fixture: Fixture = {}) {
    const asOf = fixture.asOf ?? AS_OF;
    const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        $queryRaw: jest.fn(
            (
                first: TemplateStringsArray | Prisma.Sql,
                ...values: unknown[]
            ) => {
                const sql = sqlOf([first, ...values]);
                if (sql.includes('clock_timestamp')) {
                    return Promise.resolve([{ at: asOf }]);
                }
                if (sql.includes('FROM check_logs')) {
                    return Promise.resolve(
                        sql.includes('to_char(')
                            ? (fixture.availabilityRows ?? [])
                            : (fixture.uptimeRows ?? []),
                    );
                }
                return Promise.resolve([]);
            },
        ),
        monitor: { findMany: jest.fn() },
        monitoringCoverage: {
            findMany: jest.fn().mockResolvedValue(fixture.coverage ?? []),
        },
    };

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
        $transaction: jest.fn((callback: (value: typeof tx) => unknown) =>
            callback(tx),
        ),
    };

    const quotaService = {
        assertFeatureAllowed: jest.fn().mockResolvedValue(undefined),
    };
    const cache = {
        getOrSet: (_key: string, factory: () => unknown) => factory(),
    };
    const settings = {
        assertSlugAllowed: jest.fn().mockResolvedValue(undefined),
    };

    const service = new StatusPagesService(
        prisma as unknown as PrismaService,
        quotaService as never,
        cache as never,
        settings as never,
    );

    return { service, prisma, tx, quotaService, cache, settings };
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

        it('rejects more visible monitors than a page may expose', async () => {
            const { service, prisma } = createService();

            await expect(
                service.create('org-1', {
                    title: 'Acme status',
                    visibleMonitorIds: Array.from(
                        { length: 101 },
                        (_, index) => `monitor-${index}`,
                    ),
                }),
            ).rejects.toThrow(BadRequestException);
            expect(prisma.monitor.findMany).not.toHaveBeenCalled();
        });
    });

    describe('getPublicBySlug', () => {
        it('derives the 24h uptime per monitor from one aggregate', async () => {
            const { service, prisma, tx } = createService({
                uptimeRows: [
                    { monitorId: 'monitor-1', checks: 10, successes: 9 },
                ],
            });
            prisma.statusPage.findUnique.mockResolvedValue({
                ...statusPageRow,
                showUptime: true,
            });
            tx.monitor.findMany.mockResolvedValue([monitorRow]);

            const result = await service.getPublicBySlug('acme-status');

            expect(result.monitors[0].uptimePercent).toBe(90);
            const sqls = tx.$queryRaw.mock.calls.map(sqlOf);
            const aggregates = sqls.filter((sql) =>
                sql.includes('FROM check_logs'),
            );
            expect(aggregates).toHaveLength(2);
            const uptime = aggregates.find((sql) => !sql.includes('to_char('));
            // Same sample rule as before: LOCAL and probe rows alike.
            expect(uptime).toContain('evaluated = true');
            expect(uptime).not.toContain('source =');
        });

        it('skips uptime and availability entirely when showUptime is off', async () => {
            const { service, prisma, tx } = createService();
            prisma.statusPage.findUnique.mockResolvedValue(statusPageRow);
            tx.monitor.findMany.mockResolvedValue([monitorRow]);

            const result = await service.getPublicBySlug('acme-status');

            expect(tx.monitor.findMany).toHaveBeenCalledWith({
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
            expect(result.monitors[0].availability).toBeUndefined();
            // Only the snapshot clock, no aggregate at all.
            expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
            expect(tx.monitoringCoverage.findMany).not.toHaveBeenCalled();
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
            const { service, prisma, tx } = createService();
            prisma.statusPage.findUnique.mockResolvedValue(statusPageRow);
            tx.monitor.findMany.mockResolvedValue([
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
            expect(tx.monitor.findMany.mock.calls[0][0].where.project).toEqual({
                organizationId: 'org-1',
                deletedAt: null,
                organization: { deletedAt: null },
            });
            expect(JSON.stringify(result)).not.toContain('private-secret');
            expect(JSON.stringify(result)).not.toContain('password');
        });

        it('builds the hourly availability grid of the last 3 local days', async () => {
            const { service, prisma, tx } = createService({
                coverage: [
                    {
                        projectId: 'project-1',
                        checksStartedAt: new Date('2026-01-01T00:00:00.000Z'),
                    },
                ],
                availabilityRows: [
                    {
                        monitorId: 'monitor-1',
                        day: '2026-03-03',
                        hour: 0,
                        checks: 4,
                        successes: 3,
                    },
                    {
                        monitorId: 'monitor-1',
                        day: '2026-03-05',
                        hour: 1,
                        checks: 2,
                        successes: 2,
                    },
                ],
            });
            prisma.statusPage.findUnique.mockResolvedValue({
                ...statusPageRow,
                showUptime: true,
            });
            tx.monitor.findMany.mockResolvedValue([monitorRow]);

            const result = await service.getPublicBySlug('acme-status', 'UTC');
            const availability = result.monitors[0].availability!;

            expect(availability.tz).toBe('UTC');
            expect(availability.days).toEqual([
                '2026-03-03',
                '2026-03-04',
                '2026-03-05',
            ]);
            expect(availability.hours).toHaveLength(24);
            expect(availability.cells).toEqual([
                [0, 0, 75],
                [1, 2, 100],
            ]);
            expect(availability.unavailableCells).toEqual([]);
            expect(availability.worst).toEqual({
                day: '2026-03-03',
                hour: 0,
                value: 75,
            });
            expect(availability.history).toEqual(
                expect.objectContaining({
                    retentionDays: 90,
                    status: 'AVAILABLE',
                }),
            );
        });

        it('reports hours that reach before the project watermark as unavailable', async () => {
            const { service, prisma, tx } = createService({
                coverage: [
                    {
                        projectId: 'project-1',
                        checksStartedAt: new Date('2026-03-04T10:30:00.000Z'),
                    },
                ],
            });
            prisma.statusPage.findUnique.mockResolvedValue({
                ...statusPageRow,
                showUptime: true,
            });
            tx.monitor.findMany.mockResolvedValue([monitorRow]);

            const result = await service.getPublicBySlug('acme-status', 'UTC');
            const availability = result.monitors[0].availability!;

            // 03-04 10:00-11:00 still reaches before 10:30, 11:00-12:00 does not.
            expect(availability.unavailableCells).toContainEqual([10, 1]);
            expect(availability.unavailableCells).not.toContainEqual([11, 1]);
            expect(availability.unavailableCells).toContainEqual([23, 0]);
            expect(availability.cells).toEqual([]);
            expect(availability.history.status).toBe('TRUNCATED');
        });

        it('truncates every monitor against the watermark of its own project', async () => {
            const { service, prisma, tx } = createService({
                coverage: [
                    {
                        projectId: 'project-1',
                        checksStartedAt: new Date('2026-03-04T10:30:00.000Z'),
                    },
                    {
                        projectId: 'project-2',
                        checksStartedAt: new Date('2026-01-01T00:00:00.000Z'),
                    },
                ],
                availabilityRows: [
                    {
                        monitorId: 'monitor-1',
                        day: '2026-03-04',
                        hour: 12,
                        checks: 2,
                        successes: 1,
                    },
                    {
                        monitorId: 'monitor-2',
                        day: '2026-03-04',
                        hour: 12,
                        checks: 2,
                        successes: 2,
                    },
                ],
            });
            prisma.statusPage.findUnique.mockResolvedValue({
                ...statusPageRow,
                visibleMonitorIds: ['monitor-1', 'monitor-2'],
                showUptime: true,
            });
            tx.monitor.findMany.mockResolvedValue([
                monitorRow,
                monitor({ id: 'monitor-2', projectId: 'project-2' }),
            ]);

            const result = await service.getPublicBySlug('acme-status', 'UTC');

            expect(result.monitors[0].availability!.history.status).toBe(
                'TRUNCATED',
            );
            expect(result.monitors[1].availability!.history.status).toBe(
                'AVAILABLE',
            );
            expect(result.monitors[0].availability!.cells).toEqual([
                [12, 1, 50],
            ]);
            expect(result.monitors[1].availability!.cells).toEqual([
                [12, 1, 100],
            ]);
        });

        it('credits no history to a monitor whose project has no coverage row', async () => {
            const { service, prisma, tx } = createService();
            prisma.statusPage.findUnique.mockResolvedValue({
                ...statusPageRow,
                showUptime: true,
            });
            tx.monitor.findMany.mockResolvedValue([monitorRow]);

            const result = await service.getPublicBySlug('acme-status', 'UTC');
            const availability = result.monitors[0].availability!;

            // Every hour that already started is unreachable: 24 + 24 + 12.
            expect(availability.unavailableCells).toHaveLength(60);
            expect(availability.cells).toEqual([]);
            expect(availability.history.status).toBe('TRUNCATED');
        });
    });
});
