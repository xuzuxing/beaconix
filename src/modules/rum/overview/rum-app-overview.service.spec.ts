import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RumAppOverviewService } from './rum-app-overview.service';

describe('RumAppOverviewService', () => {
    const principal = { type: 'USER', userId: 'user-1' } as never;

    function setup(
        options: {
            app?: { id: string } | null;
            traffic?: Record<string, bigint>;
            requests?: Record<string, unknown>;
            errors?: Record<string, bigint>;
            series?: {
                events?: unknown[];
                requests?: unknown[];
                errors?: unknown[];
            };
        } = {},
    ) {
        const app = options.app === undefined ? { id: 'app-1' } : options.app;
        const prisma = {
            rumApp: { findFirst: jest.fn().mockResolvedValue(app) },
            $queryRaw: jest
                .fn()
                // traffic, requests, errors, then the three series queries
                .mockResolvedValueOnce([
                    options.traffic ?? {
                        pv: 100n,
                        uv: 40n,
                        clicks: 250n,
                        events: 12n,
                    },
                ])
                .mockResolvedValueOnce([
                    options.requests ?? {
                        total: 200n,
                        success: 190n,
                        failures: 10n,
                        p75: 310.4,
                        average: 180.6,
                    },
                ])
                .mockResolvedValueOnce([
                    options.errors ?? { js: 5n, custom: 2n },
                ])
                .mockResolvedValueOnce(
                    options.series?.events ?? [
                        { idx: 0, pv: 60n, uv: 25n, clicks: 150n, events: 8n },
                        { idx: 1, pv: 40n, uv: 15n, clicks: 100n, events: 4n },
                    ],
                )
                .mockResolvedValueOnce(
                    options.series?.requests ?? [
                        { idx: 0, total: 120n, failures: 6n },
                        { idx: 1, total: 80n, failures: 4n },
                    ],
                )
                .mockResolvedValueOnce(
                    options.series?.errors ?? [
                        { idx: 0, js: 3n, custom: 1n },
                        { idx: 1, js: 2n, custom: 1n },
                    ],
                ),
        };
        const access = {
            project: jest.fn().mockResolvedValue({ organizationId: 'org-1' }),
        };
        const service = new RumAppOverviewService(
            prisma as never,
            access as never,
        );
        return { service, prisma, access };
    }

    it('aggregates traffic, request health and errors for one window', async () => {
        const { service, access } = setup();
        const result = await service.overview(
            'project-1',
            'app-1',
            {},
            principal,
        );

        expect(access.project).toHaveBeenCalledWith(
            principal,
            'project-1',
            'rum.read',
        );
        expect(result.traffic).toEqual({ pv: 100, uv: 40, clicks: 250 });
        expect(result.requests).toEqual({
            total: 200,
            success: 190,
            failures: 10,
            successRate: 95,
            errorRate: 5,
            p75: 310,
            average: 181,
        });
        expect(result.errors).toEqual({
            js: 5,
            custom: 2,
            total: 7,
            events: 12,
            jsRate: 5,
        });
        expect(result.bucketMinutes).toBe(60);
    });

    it('fills every bucket so the chart has no holes', async () => {
        const { service } = setup();
        const from = new Date('2026-11-04T00:00:00.000Z');
        const to = new Date('2026-11-04T02:00:00.000Z');
        const result = await service.overview(
            'project-1',
            'app-1',
            {
                from: from.toISOString(),
                to: to.toISOString(),
                bucketMinutes: 60,
            },
            principal,
        );

        expect(result.series).toHaveLength(3);
        expect(result.series[0]).toMatchObject({
            bucketStart: from,
            pv: 60,
            uv: 25,
            clicks: 150,
            requests: 120,
            failures: 6,
            jsErrors: 3,
            customErrors: 1,
            events: 8,
        });
        expect(result.series[2]).toMatchObject({
            bucketStart: new Date('2026-11-04T02:00:00.000Z'),
            pv: 0,
            requests: 0,
            jsErrors: 0,
        });
    });

    it('never invents rates when there is no traffic', async () => {
        const { service } = setup({
            traffic: { pv: 0n, uv: 0n, clicks: 0n, events: 0n },
            requests: {
                total: 0n,
                success: 0n,
                failures: 0n,
                p75: null,
                average: null,
            },
            errors: { js: 0n, custom: 0n },
            series: { events: [], requests: [], errors: [] },
        });
        const result = await service.overview(
            'project-1',
            'app-1',
            {},
            principal,
        );

        expect(result.errors.jsRate).toBeNull();
        expect(result.requests.successRate).toBeNull();
        expect(result.requests.errorRate).toBeNull();
        expect(result.requests.p75).toBeNull();
        expect(result.series.every((point) => point.pv === 0)).toBe(true);
    });

    it('rejects an inverted or oversized window', async () => {
        const { service } = setup();
        await expect(
            service.overview(
                'project-1',
                'app-1',
                {
                    from: '2026-11-05T00:00:00.000Z',
                    to: '2026-11-04T00:00:00.000Z',
                },
                principal,
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
            service.overview(
                'project-1',
                'app-1',
                {
                    from: '2026-01-01T00:00:00.000Z',
                    to: '2026-11-04T00:00:00.000Z',
                },
                principal,
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('hides apps outside the authorized organization or project', async () => {
        const { service, prisma } = setup({ app: null });
        await expect(
            service.overview('project-1', 'app-1', {}, principal),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(prisma.rumApp.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'app-1',
                organizationId: 'org-1',
                projectId: 'project-1',
                deletedAt: null,
            },
            select: { id: true },
        });
    });
});
