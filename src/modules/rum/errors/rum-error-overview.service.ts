import { Injectable, NotFoundException } from '@nestjs/common';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { ProjectAccessService } from '../../../common/authorization/project-access.service';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../infra/database/prisma.service';
import type { QueryRumErrorOverviewDto } from '../dto';
import {
    percentage,
    resolveOverviewWindow,
} from '../overview/rum-overview-window';
import type { RumErrorOverviewEntity } from './rum-error-overview.entity';

interface TotalsRow {
    errors: bigint;
    js: bigint;
    custom: bigint;
    pv: bigint;
    affectedUsers: bigint;
    affectedPages: bigint;
}

interface OpenGroupRow {
    count: bigint;
}

interface ErrorSeriesRow {
    idx: number;
    errors: bigint;
    js: bigint;
    custom: bigint;
}

interface PvSeriesRow {
    idx: number;
    pv: bigint;
}

/**
 * 错误列表页顶部图表的数据源。
 *
 * 口径：
 * - 错误次数来自错误发生记录（不是错误组数），JS = category 非 MANUAL，自定义 = MANUAL
 * - 错误率的分母是同一窗口内的 PV（`$pageview`），PV 为 0 时为 null
 * - 影响用户按 user / anonymous id / session 兜底去重，影响页面按 `page` 去重
 * - 未解决错误组不按窗口过滤，反映当前待处理量
 */
@Injectable()
export class RumErrorOverviewService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ProjectAccessService,
    ) {}

    async overview(
        projectId: string,
        appId: string,
        query: QueryRumErrorOverviewDto,
        principal: AccessPrincipal,
    ): Promise<RumErrorOverviewEntity> {
        const access = await this.access.project(
            principal,
            projectId,
            'rum.read',
        );
        await this.ensureApp(access.organizationId, projectId, appId);

        const { from, to, rangeMs, bucketMinutes } = resolveOverviewWindow(
            query.from,
            query.to,
            query.bucketMinutes,
        );
        const bucketSeconds = bucketMinutes * 60;

        const [totals, openGroups, errorSeries, pvSeries] = await Promise.all([
            this.totals(appId, from, to),
            this.openGroups(appId),
            this.errorSeries(appId, from, to, bucketSeconds),
            this.pvSeries(appId, from, to, bucketSeconds),
        ]);

        const errors = Number(totals.errors);
        const pv = Number(totals.pv);

        return {
            from,
            to,
            bucketMinutes,
            totals: {
                errors,
                js: Number(totals.js),
                custom: Number(totals.custom),
                pv,
                errorRate: percentage(errors, pv),
                affectedUsers: Number(totals.affectedUsers),
                affectedPages: Number(totals.affectedPages),
                openGroups: Number(openGroups),
            },
            series: buildSeries(
                from,
                rangeMs,
                bucketMinutes,
                errorSeries,
                pvSeries,
            ),
        };
    }

    private totals(appId: string, from: Date, to: Date) {
        return this.prisma
            .$queryRaw<TotalsRow[]>(
                Prisma.sql`
                SELECT
                    COUNT(*)::bigint AS errors,
                    COUNT(*) FILTER (WHERE "category"::text <> 'MANUAL')::bigint AS js,
                    COUNT(*) FILTER (WHERE "category"::text = 'MANUAL')::bigint AS custom,
                    COUNT(DISTINCT COALESCE("endUserId", "anonymousId", "sessionId"))::bigint
                        AS "affectedUsers",
                    COUNT(DISTINCT "page")::bigint AS "affectedPages",
                    (
                        SELECT COUNT(*) FROM "rum_events"
                        WHERE "appId" = ${appId}
                          AND "eventName" = '$pageview'
                          AND "receivedAt" >= ${from}
                          AND "receivedAt" <= ${to}
                    )::bigint AS pv
                FROM "rum_error_occurrences"
                WHERE "appId" = ${appId}
                  AND "receivedAt" >= ${from}
                  AND "receivedAt" <= ${to}
            `,
            )
            .then(
                (rows) =>
                    rows[0] ?? {
                        errors: 0n,
                        js: 0n,
                        custom: 0n,
                        pv: 0n,
                        affectedUsers: 0n,
                        affectedPages: 0n,
                    },
            );
    }

    private openGroups(appId: string) {
        return this.prisma
            .$queryRaw<OpenGroupRow[]>(
                Prisma.sql`
                SELECT COUNT(*)::bigint AS count
                FROM "rum_error_groups"
                WHERE "appId" = ${appId}
                  AND "status"::text = 'UNRESOLVED'
            `,
            )
            .then((rows) => rows[0]?.count ?? 0n);
    }

    private errorSeries(
        appId: string,
        from: Date,
        to: Date,
        bucketSeconds: number,
    ) {
        return this.prisma.$queryRaw<ErrorSeriesRow[]>(
            Prisma.sql`
                SELECT
                    FLOOR(EXTRACT(EPOCH FROM ("receivedAt" - ${from})) / ${bucketSeconds})::int AS idx,
                    COUNT(*)::bigint AS errors,
                    COUNT(*) FILTER (WHERE "category"::text <> 'MANUAL')::bigint AS js,
                    COUNT(*) FILTER (WHERE "category"::text = 'MANUAL')::bigint AS custom
                FROM "rum_error_occurrences"
                WHERE "appId" = ${appId}
                  AND "receivedAt" >= ${from}
                  AND "receivedAt" <= ${to}
                GROUP BY idx
                ORDER BY idx ASC
            `,
        );
    }

    private pvSeries(
        appId: string,
        from: Date,
        to: Date,
        bucketSeconds: number,
    ) {
        return this.prisma.$queryRaw<PvSeriesRow[]>(
            Prisma.sql`
                SELECT
                    FLOOR(EXTRACT(EPOCH FROM ("receivedAt" - ${from})) / ${bucketSeconds})::int AS idx,
                    COUNT(*)::bigint AS pv
                FROM "rum_events"
                WHERE "appId" = ${appId}
                  AND "eventName" = '$pageview'
                  AND "receivedAt" >= ${from}
                  AND "receivedAt" <= ${to}
                GROUP BY idx
                ORDER BY idx ASC
            `,
        );
    }

    private async ensureApp(
        organizationId: string,
        projectId: string,
        appId: string,
    ): Promise<void> {
        const app = await this.prisma.rumApp.findFirst({
            where: { id: appId, organizationId, projectId, deletedAt: null },
            select: { id: true },
        });
        if (!app) throw new NotFoundException('RUM app not found');
    }
}

function buildSeries(
    from: Date,
    rangeMs: number,
    bucketMinutes: number,
    errors: ErrorSeriesRow[],
    pv: PvSeriesRow[],
) {
    const bucketMs = bucketMinutes * 60_000;
    const bucketCount = Math.max(1, Math.floor(rangeMs / bucketMs) + 1);
    const series = Array.from({ length: bucketCount }, (_, index) => ({
        bucketStart: new Date(from.getTime() + index * bucketMs),
        errors: 0,
        js: 0,
        custom: 0,
        pv: 0,
        errorRate: null as number | null,
    }));
    for (const row of errors) {
        const target = series[row.idx];
        if (!target) continue;
        target.errors = Number(row.errors);
        target.js = Number(row.js);
        target.custom = Number(row.custom);
    }
    for (const row of pv) {
        const target = series[row.idx];
        if (!target) continue;
        target.pv = Number(row.pv);
    }
    for (const point of series) {
        point.errorRate = percentage(point.errors, point.pv);
    }
    return series;
}
