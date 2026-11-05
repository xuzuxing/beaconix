import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RumErrorOverviewService } from './rum-error-overview.service';

describe('RumErrorOverviewService', () => {
    const principal = { type: 'USER', userId: 'user-1' } as never;

    function setup(
        options: {
            app?: { id: string } | null;
            totals?: Record<string, bigint>;
            openGroups?: bigint;
            series?: { errors?: unknown[]; pv?: unknown[] };
        } = {},
    ) {
        const app = options.app === undefined ? { id: 'app-1' } : options.app;
        const prisma = {
            rumApp: { findFirst: jest.fn().mockResolvedValue(app) },
            $queryRaw: jest
                .fn()
                // totals, open groups, then the two series queries
                .mockResolvedValueOnce([
                    options.totals ?? {
                        errors: 40n,
                        js: 30n,
                        custom: 10n,
                        pv: 800n,
                        affectedUsers: 12n,
                        affectedPages: 5n,
                    },
                ])
                .mockResolvedValueOnce([{ count: options.openGroups ?? 3n }])
                .mockResolvedValueOnce(
                    options.series?.errors ?? [
                        { idx: 0, errors: 30n, js: 22n, custom: 8n },
                        { idx: 1, errors: 10n, js: 8n, custom: 2n },
                    ],
                )
                .mockResolvedValueOnce(
                    options.series?.pv ?? [
                        { idx: 0, pv: 600n },
                        { idx: 1, pv: 200n },
                    ],
                ),
        };
        const access = {
            project: jest.fn().mockResolvedValue({ organizationId: 'org-1' }),
        };
        const service = new RumErrorOverviewService(
            prisma as never,
            access as never,
        );
        return { service, prisma, access };
    }

    it('aggregates error totals against page views', async () => {
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
        expect(result.totals).toEqual({
            errors: 40,
            js: 30,
            custom: 10,
            pv: 800,
            errorRate: 5,
            affectedUsers: 12,
            affectedPages: 5,
            openGroups: 3,
        });
        expect(result.bucketMinutes).toBe(60);
    });

    it('fills every bucket and computes the per-bucket error rate', async () => {
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
            errors: 30,
            js: 22,
            custom: 8,
            pv: 600,
            errorRate: 5,
        });
        // 第二个桶没有 PV，错误率保持 null 而不是 0%
        const empty = result.series[2];
        expect(empty).toMatchObject({ errors: 0, pv: 0, errorRate: null });
    });

    it('never invents a rate without traffic', async () => {
        const { service } = setup({
            totals: {
                errors: 6n,
                js: 4n,
                custom: 2n,
                pv: 0n,
                affectedUsers: 3n,
                affectedPages: 2n,
            },
            openGroups: 0n,
            series: {
                errors: [{ idx: 0, errors: 6n, js: 4n, custom: 2n }],
                pv: [],
            },
        });
        const result = await service.overview(
            'project-1',
            'app-1',
            {},
            principal,
        );

        expect(result.totals.errorRate).toBeNull();
        expect(result.series.every((point) => point.errorRate === null)).toBe(
            true,
        );
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

    it('hides errors of apps outside the authorized project', async () => {
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
