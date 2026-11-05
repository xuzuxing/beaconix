import { BadRequestException } from '@nestjs/common';
import { RumPerformanceService } from './rum-performance.service';

describe('RumPerformanceService', () => {
    function bucket(overrides: Record<string, unknown> = {}) {
        return {
            metric: 'LCP',
            bucketStart: new Date('2026-11-04T10:00:00.000Z'),
            count: 4,
            sum: 4000,
            failureCount: 0,
            goodCount: 3,
            needsImprovementCount: 1,
            poorCount: 0,
            histogram: { le_1200: 4 },
            ...overrides,
        };
    }

    function setup() {
        const prisma = {
            rumApp: {
                findFirst: jest.fn().mockResolvedValue({ id: 'app-1' }),
            },
            rumPerfBucket: {
                findMany: jest.fn().mockResolvedValue([]),
            },
            $queryRaw: jest.fn().mockResolvedValue([]),
        };
        const access = {
            project: jest.fn().mockResolvedValue({ organizationId: 'org-1' }),
        };
        return {
            service: new RumPerformanceService(
                prisma as never,
                access as never,
            ),
            prisma,
            access,
        };
    }

    const principal = { type: 'USER', userId: 'user-1' } as const;

    it('summarises p75, rating and rating distribution per metric', async () => {
        const { service, prisma } = setup();
        prisma.rumPerfBucket.findMany.mockResolvedValue([
            bucket(),
            bucket({
                bucketStart: new Date('2026-11-04T11:00:00.000Z'),
                count: 1,
                sum: 5000,
                goodCount: 0,
                needsImprovementCount: 0,
                poorCount: 1,
                histogram: { le_6000: 1 },
            }),
        ]);

        const result = await service.summary(
            'project-1',
            'app-1',
            {},
            principal,
        );

        const lcp = result.metrics.find((metric) => metric.metric === 'LCP');
        expect(lcp).toMatchObject({
            count: 5,
            average: 1800,
            // 4 of 5 samples sit at or below 1200ms, so p75 lands there.
            p75: 1200,
            rating: 'GOOD',
            good: 3,
            needsImprovement: 1,
            poor: 1,
            goodRate: 60,
            poorRate: 20,
        });
        expect(prisma.rumApp.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: 'app-1',
                    organizationId: 'org-1',
                }),
            }),
        );
    });

    it('builds a time series and a window-over-window change', async () => {
        const { service, prisma } = setup();
        prisma.rumPerfBucket.findMany
            .mockResolvedValueOnce([
                bucket(),
                bucket({ bucketStart: new Date('2026-11-04T11:00:00.000Z') }),
            ])
            .mockResolvedValueOnce([
                bucket({ histogram: { le_1200: 4 }, count: 4, sum: 4000 }),
            ]);

        const result = await service.series(
            'project-1',
            'app-1',
            { metrics: 'LCP' },
            principal,
        );

        const series = result.series[0];
        expect(series.metric).toBe('LCP');
        expect(series.points).toHaveLength(2);
        expect(series.current).toMatchObject({
            count: 8,
            p75: 1200,
            rating: 'GOOD',
            changePercent: 0,
        });
        expect(series.previous).toMatchObject({ count: 4, p75: 1200 });
    });

    it('returns page-level p75 with the error rate', async () => {
        const { service, prisma } = setup();
        prisma.$queryRaw
            .mockResolvedValueOnce([
                { page: '/dashboard', samples: 10, p75: 2100 },
                { page: '/checkout', samples: 4, p75: 5200 },
            ])
            .mockResolvedValueOnce([
                { page: '/dashboard', errors: 1 },
                { page: '/checkout', errors: 2 },
            ]);

        const result = await service.pages(
            'project-1',
            'app-1',
            { limit: 20 },
            principal,
        );

        expect(result.items).toEqual([
            {
                page: '/dashboard',
                samples: 10,
                p75: 2100,
                errors: 1,
                errorRate: 10,
            },
            {
                page: '/checkout',
                samples: 4,
                p75: 5200,
                errors: 2,
                errorRate: 50,
            },
        ]);
    });

    it('returns the slowest resources with failure rate', async () => {
        const { service, prisma } = setup();
        prisma.$queryRaw.mockResolvedValueOnce([
            {
                dimension: 'https://cdn.example.com/app.js',
                samples: 8,
                p75: 3200,
                failures: 2,
            },
        ]);

        const result = await service.resources(
            'project-1',
            'app-1',
            { metric: 'RESOURCE', limit: 20 },
            principal,
        );

        expect(result.items).toEqual([
            {
                dimension: 'https://cdn.example.com/app.js',
                samples: 8,
                p75: 3200,
                failures: 2,
                failureRate: 25,
            },
        ]);
    });

    it('rejects unknown metrics and inverted ranges', async () => {
        const { service } = setup();

        await expect(
            service.summary(
                'project-1',
                'app-1',
                { metrics: 'LCP,FOO' },
                principal,
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
            service.summary(
                'project-1',
                'app-1',
                {
                    from: '2026-11-04T00:00:00.000Z',
                    to: '2026-11-03T00:00:00.000Z',
                },
                principal,
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});
