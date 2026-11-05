import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { ProjectAccessService } from '../../../common/authorization/project-access.service';
import { PrismaService } from '../../../infra/database/prisma.service';
import {
    RUM_PERF_METRICS,
    type QueryRumPerformanceDto,
    type QueryRumPerformancePagesDto,
    type QueryRumPerformanceResourcesDto,
    type RumPerfMetricValue,
} from '../dto';
import {
    mergeHistograms,
    percentileFromHistogram,
    ratingFromValue,
} from '../performance/rum-perf-histogram';

const STAR = '*';
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 1;
const DEFAULT_METRICS: RumPerfMetricValue[] = [
    'LCP',
    'INP',
    'CLS',
    'FCP',
    'TTFB',
];

interface BucketRow {
    bucketStart: Date;
    count: number;
    sum: number;
    failureCount: number;
    goodCount: number;
    needsImprovementCount: number;
    poorCount: number;
    histogram: unknown;
}

interface PageRow {
    page: string;
    samples: number;
    p75: number | null;
}

interface ErrorPageRow {
    page: string;
    errors: number;
}

interface ResourceRow {
    dimension: string;
    samples: number;
    p75: number | null;
    failures: number;
}

export interface MetricStats {
    metric: RumPerfMetricValue;
    count: number;
    average: number | null;
    p75: number | null;
    good: number;
    needsImprovement: number;
    poor: number;
    failures: number;
}

@Injectable()
export class RumPerformanceService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ProjectAccessService,
    ) {}

    async series(
        projectId: string,
        appId: string,
        query: QueryRumPerformanceDto,
        principal: AccessPrincipal,
    ) {
        await this.authorize(projectId, appId, principal);
        const metrics = this.parseMetrics(query.metrics);
        const { from, to } = this.range(query.from, query.to);
        const where = {
            appId,
            metric: { in: metrics },
            bucketStart: { gte: from, lte: to },
            ...(query.page ? { page: query.page } : {}),
            ...(query.release !== undefined
                ? { release: query.release === '' ? STAR : query.release }
                : {}),
        };
        const previousFrom = new Date(
            from.getTime() - (to.getTime() - from.getTime()),
        );
        const [currentRows, previousRows] = await Promise.all([
            this.buckets(where),
            this.buckets({
                ...where,
                bucketStart: { gte: previousFrom, lt: from },
            }),
        ]);

        const series = metrics.map((metric) => {
            const byBucket = new Map<number, BucketRow[]>();
            for (const row of currentRows.filter(
                (item) => item.metric === metric,
            )) {
                const key = row.bucketStart.getTime();
                const list = byBucket.get(key) ?? [];
                list.push(row);
                byBucket.set(key, list);
            }
            const points = [...byBucket.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([timestamp, rows]) => {
                    const stats = this.summarize(metric, rows);
                    return {
                        bucketStart: new Date(timestamp),
                        count: stats.count,
                        average: stats.average,
                        p75: stats.p75,
                    };
                });
            const current = this.summarize(
                metric,
                this.only(currentRows, metric),
            );
            const previous = this.summarize(
                metric,
                this.only(previousRows, metric),
            );
            return {
                metric,
                points,
                current: {
                    ...current,
                    rating:
                        current.p75 === null
                            ? null
                            : ratingFromValue(metric, current.p75),
                    changePercent: this.changePercent(
                        current.p75,
                        previous.p75,
                    ),
                },
                previous,
            };
        });

        return { from, to, series };
    }

    async summary(
        projectId: string,
        appId: string,
        query: QueryRumPerformanceDto,
        principal: AccessPrincipal,
    ) {
        await this.authorize(projectId, appId, principal);
        const metrics = this.parseMetrics(query.metrics);
        const { from, to } = this.range(query.from, query.to);
        const rows = await this.buckets({
            appId,
            metric: { in: metrics },
            bucketStart: { gte: from, lte: to },
            ...(query.page ? { page: query.page } : {}),
            ...(query.release !== undefined
                ? { release: query.release === '' ? STAR : query.release }
                : {}),
        });
        return {
            from,
            to,
            metrics: metrics.map((metric) => {
                const stats = this.summarize(metric, this.only(rows, metric));
                return {
                    ...stats,
                    rating:
                        stats.p75 === null
                            ? null
                            : ratingFromValue(metric, stats.p75),
                    goodRate:
                        stats.count > 0
                            ? Math.round((stats.good / stats.count) * 1000) / 10
                            : null,
                    poorRate:
                        stats.count > 0
                            ? Math.round((stats.poor / stats.count) * 1000) / 10
                            : null,
                };
            }),
        };
    }

    async pages(
        projectId: string,
        appId: string,
        query: QueryRumPerformancePagesDto,
        principal: AccessPrincipal,
    ) {
        await this.authorize(projectId, appId, principal);
        const { from, to } = this.range(query.from, query.to);
        const [pageRows, errorRows] = await Promise.all([
            this.prisma.$queryRaw<PageRow[]>`
                SELECT COALESCE("page", '') AS "page",
                       COUNT(*)::int AS "samples",
                       percentile_cont(0.75) WITHIN GROUP (
                           ORDER BY "value"
                       ) AS "p75"
                FROM "rum_perf_samples"
                WHERE "appId" = ${appId}
                  AND "metric" = 'PAGE_LOAD'
                  AND "receivedAt" >= ${from}
                  AND "receivedAt" <= ${to}
                GROUP BY 1
                ORDER BY "p75" DESC NULLS LAST
                LIMIT ${query.limit}
            `,
            this.prisma.$queryRaw<ErrorPageRow[]>`
                SELECT COALESCE("page", '') AS "page",
                       COUNT(*)::int AS "errors"
                FROM "rum_error_occurrences"
                WHERE "appId" = ${appId}
                  AND "receivedAt" >= ${from}
                  AND "receivedAt" <= ${to}
                GROUP BY 1
            `,
        ]);
        const errors = new Map(
            errorRows.map((row) => [row.page, Number(row.errors)]),
        );
        return {
            from,
            to,
            items: pageRows.map((row) => {
                const errorCount = errors.get(row.page) ?? 0;
                const samples = Number(row.samples);
                return {
                    page: row.page,
                    samples,
                    p75: row.p75 === null ? null : Number(row.p75),
                    errors: errorCount,
                    errorRate:
                        samples > 0
                            ? Math.round((errorCount / samples) * 10000) / 100
                            : null,
                };
            }),
        };
    }

    async resources(
        projectId: string,
        appId: string,
        query: QueryRumPerformanceResourcesDto,
        principal: AccessPrincipal,
    ) {
        await this.authorize(projectId, appId, principal);
        if (!['RESOURCE', 'HTTP'].includes(query.metric)) {
            throw new BadRequestException('metric must be RESOURCE or HTTP');
        }
        const { from, to } = this.range(query.from, query.to);
        const rows = await this.prisma.$queryRaw<ResourceRow[]>`
            SELECT COALESCE("dimension", '') AS "dimension",
                   COUNT(*)::int AS "samples",
                   percentile_cont(0.75) WITHIN GROUP (
                       ORDER BY "value"
                   ) AS "p75",
                   (COUNT(*) FILTER (WHERE "success" = false))::int
                       AS "failures"
            FROM "rum_perf_samples"
            WHERE "appId" = ${appId}
              AND "metric" = ${query.metric}::"RumPerfMetric"
              AND "receivedAt" >= ${from}
              AND "receivedAt" <= ${to}
            GROUP BY 1
            ORDER BY "p75" DESC NULLS LAST
            LIMIT ${query.limit}
        `;
        return {
            from,
            to,
            items: rows.map((row) => {
                const samples = Number(row.samples);
                const failures = Number(row.failures);
                return {
                    dimension: row.dimension,
                    samples,
                    p75: row.p75 === null ? null : Number(row.p75),
                    failures,
                    failureRate:
                        samples > 0
                            ? Math.round((failures / samples) * 10000) / 100
                            : null,
                };
            }),
        };
    }

    private buckets(where: {
        appId: string;
        metric: { in: RumPerfMetricValue[] };
        bucketStart: { gte: Date; lte?: Date; lt?: Date };
        page?: string;
        release?: string;
    }) {
        return this.prisma.rumPerfBucket.findMany({
            where,
            select: {
                metric: true,
                bucketStart: true,
                count: true,
                sum: true,
                failureCount: true,
                goodCount: true,
                needsImprovementCount: true,
                poorCount: true,
                histogram: true,
            },
            orderBy: { bucketStart: 'asc' },
        });
    }

    private only(
        rows: Array<BucketRow & { metric: string }>,
        metric: RumPerfMetricValue,
    ) {
        return rows.filter((row) => row.metric === metric);
    }

    private summarize(
        metric: RumPerfMetricValue,
        rows: BucketRow[],
    ): MetricStats {
        let count = 0;
        let sum = 0;
        let failures = 0;
        let good = 0;
        let needsImprovement = 0;
        let poor = 0;
        const histogram: Record<string, number> = {};
        for (const row of rows) {
            count += Number(row.count ?? 0);
            sum += Number(row.sum ?? 0);
            failures += Number(row.failureCount ?? 0);
            good += Number(row.goodCount ?? 0);
            needsImprovement += Number(row.needsImprovementCount ?? 0);
            poor += Number(row.poorCount ?? 0);
            mergeHistograms(
                histogram,
                row.histogram as Record<string, unknown>,
            );
        }
        return {
            metric,
            count,
            average: count ? Math.round((sum / count) * 10) / 10 : null,
            p75: percentileFromHistogram(metric, histogram, 0.75),
            good,
            needsImprovement,
            poor,
            failures,
        };
    }

    private changePercent(
        current: number | null,
        previous: number | null,
    ): number | null {
        if (current === null || previous === null || previous === 0)
            return null;
        return Math.round(((current - previous) / previous) * 1000) / 10;
    }

    private parseMetrics(raw?: string): RumPerfMetricValue[] {
        if (!raw) return DEFAULT_METRICS;
        const list = raw
            .split(',')
            .map((item) => item.trim().toUpperCase())
            .filter(Boolean);
        const invalid = list.filter(
            (item) => !RUM_PERF_METRICS.includes(item as RumPerfMetricValue),
        );
        if (invalid.length)
            throw new BadRequestException(
                `Unsupported performance metric(s): ${invalid.join(', ')}`,
            );
        const unique = [...new Set(list)] as RumPerfMetricValue[];
        return unique.length ? unique : DEFAULT_METRICS;
    }

    private range(from?: string, to?: string) {
        const end = to ? new Date(to) : new Date();
        const start = from
            ? new Date(from)
            : new Date(end.getTime() - DEFAULT_RANGE_DAYS * MILLIS_PER_DAY);
        if (start > end)
            throw new BadRequestException('from must not be after to');
        return { from: start, to: end };
    }

    private async authorize(
        projectId: string,
        appId: string,
        principal: AccessPrincipal,
    ): Promise<void> {
        const access = await this.access.project(
            principal,
            projectId,
            'rum.read',
        );
        const app = await this.prisma.rumApp.findFirst({
            where: {
                id: appId,
                organizationId: access.organizationId,
                projectId,
                deletedAt: null,
            },
            select: { id: true },
        });
        if (!app) throw new NotFoundException('RUM app not found');
    }
}
