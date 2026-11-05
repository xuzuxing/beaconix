import { Injectable, NotFoundException } from '@nestjs/common';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { ProjectAccessService } from '../../../common/authorization/project-access.service';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../infra/database/prisma.service';
import type { QueryRumAppOverviewDto } from '../dto';
import type { RumAppOverviewEntity } from './rum-app-overview.entity';
import { percentage, resolveOverviewWindow } from './rum-overview-window';

interface TrafficRow {
    pv: bigint;
    uv: bigint;
    clicks: bigint;
    events: bigint;
}

interface RequestRow {
    total: bigint;
    success: bigint;
    failures: bigint;
    p75: number | null;
    average: number | null;
}

interface ErrorRow {
    js: bigint;
    custom: bigint;
}

interface EventSeriesRow {
    idx: number;
    pv: bigint;
    uv: bigint;
    clicks: bigint;
    events: bigint;
}

interface RequestSeriesRow {
    idx: number;
    total: bigint;
    failures: bigint;
}

interface ErrorSeriesRow {
    idx: number;
    js: bigint;
    custom: bigint;
}

/**
 * 应用概览：把分散在事件、性能样本与错误发生记录里的数据按同一时间窗聚合成一屏。
 *
 * 口径说明：
 * - PV/UV/点击量来自 SDK 自动上报的系统事件 `$pageview` / `$click`
 * - 请求量/成功率/耗时来自 HTTP 性能样本（`success` 由 SDK 按状态码判定）；
 *   静态资源失败属于资源错误，不计入接口指标
 * - JS 错误是 category 非 MANUAL 的发生记录，自定义错误是 MANUAL
 * - 事件量排除 `$` 前缀的系统事件
 * - JS 错误率的分母是 PV，PV 为 0 时为 null（不编造数值）
 */
@Injectable()
export class RumAppOverviewService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ProjectAccessService,
    ) {}

    async overview(
        projectId: string,
        appId: string,
        query: QueryRumAppOverviewDto,
        principal: AccessPrincipal,
    ): Promise<RumAppOverviewEntity> {
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

        const [
            traffic,
            requests,
            errors,
            eventSeries,
            requestSeries,
            errorSeries,
        ] = await Promise.all([
            this.traffic(appId, from, to),
            this.requests(appId, from, to),
            this.errors(appId, from, to),
            this.eventSeries(appId, from, to, bucketSeconds),
            this.requestSeries(appId, from, to, bucketSeconds),
            this.errorSeries(appId, from, to, bucketSeconds),
        ]);

        const pv = Number(traffic.pv);
        const clicks = Number(traffic.clicks);
        const events = Number(traffic.events);
        const requestTotal = Number(requests.total);
        const requestSuccess = Number(requests.success);
        const requestFailures = Number(requests.failures);
        const js = Number(errors.js);
        const custom = Number(errors.custom);

        return {
            from,
            to,
            bucketMinutes,
            traffic: {
                pv,
                uv: Number(traffic.uv),
                clicks,
            },
            requests: {
                total: requestTotal,
                success: requestSuccess,
                failures: requestFailures,
                successRate: percentage(requestSuccess, requestTotal),
                errorRate: percentage(requestFailures, requestTotal),
                p75: requests.p75 === null ? null : Math.round(requests.p75),
                average:
                    requests.average === null
                        ? null
                        : Math.round(requests.average),
            },
            errors: {
                js,
                custom,
                total: js + custom,
                events,
                jsRate: percentage(js, pv),
            },
            series: buildSeries(
                from,
                rangeMs,
                bucketMinutes,
                eventSeries,
                requestSeries,
                errorSeries,
            ),
        };
    }

    private traffic(appId: string, from: Date, to: Date) {
        return this.prisma
            .$queryRaw<TrafficRow[]>(
                Prisma.sql`
                SELECT
                    COUNT(*) FILTER (WHERE "eventName" = '$pageview')::bigint AS pv,
                    COUNT(DISTINCT CASE
                        WHEN "eventName" = '$pageview'
                        THEN COALESCE("endUserId", "anonymousId", "sessionId")
                    END)::bigint AS uv,
                    COUNT(*) FILTER (WHERE "eventName" = '$click')::bigint AS clicks,
                    COUNT(*) FILTER (WHERE "eventName" NOT LIKE '$%')::bigint AS events
                FROM "rum_events"
                WHERE "appId" = ${appId}
                  AND "receivedAt" >= ${from}
                  AND "receivedAt" <= ${to}
            `,
            )
            .then(
                (rows) =>
                    rows[0] ?? {
                        pv: 0n,
                        uv: 0n,
                        clicks: 0n,
                        events: 0n,
                    },
            );
    }

    private requests(appId: string, from: Date, to: Date) {
        return this.prisma
            .$queryRaw<RequestRow[]>(
                Prisma.sql`
                SELECT
                    COUNT(*)::bigint AS total,
                    COUNT(*) FILTER (WHERE "success")::bigint AS success,
                    COUNT(*) FILTER (WHERE NOT "success")::bigint AS failures,
                    percentile_cont(0.75) WITHIN GROUP (ORDER BY "value") AS p75,
                    AVG("value") AS average
                FROM "rum_perf_samples"
                WHERE "appId" = ${appId}
                  AND "metric"::text = 'HTTP'
                  AND "receivedAt" >= ${from}
                  AND "receivedAt" <= ${to}
            `,
            )
            .then(
                (rows) =>
                    rows[0] ?? {
                        total: 0n,
                        success: 0n,
                        failures: 0n,
                        p75: null,
                        average: null,
                    },
            );
    }

    private errors(appId: string, from: Date, to: Date) {
        return this.prisma
            .$queryRaw<ErrorRow[]>(
                Prisma.sql`
                SELECT
                    COUNT(*) FILTER (WHERE "category"::text <> 'MANUAL')::bigint AS js,
                    COUNT(*) FILTER (WHERE "category"::text = 'MANUAL')::bigint AS custom
                FROM "rum_error_occurrences"
                WHERE "appId" = ${appId}
                  AND "receivedAt" >= ${from}
                  AND "receivedAt" <= ${to}
            `,
            )
            .then((rows) => rows[0] ?? { js: 0n, custom: 0n });
    }

    private eventSeries(
        appId: string,
        from: Date,
        to: Date,
        bucketSeconds: number,
    ) {
        return this.prisma.$queryRaw<EventSeriesRow[]>(
            Prisma.sql`
                SELECT
                    FLOOR(EXTRACT(EPOCH FROM ("receivedAt" - ${from})) / ${bucketSeconds})::int AS idx,
                    COUNT(*) FILTER (WHERE "eventName" = '$pageview')::bigint AS pv,
                    COUNT(DISTINCT CASE
                        WHEN "eventName" = '$pageview'
                        THEN COALESCE("endUserId", "anonymousId", "sessionId")
                    END)::bigint AS uv,
                    COUNT(*) FILTER (WHERE "eventName" = '$click')::bigint AS clicks,
                    COUNT(*) FILTER (WHERE "eventName" NOT LIKE '$%')::bigint AS events
                FROM "rum_events"
                WHERE "appId" = ${appId}
                  AND "receivedAt" >= ${from}
                  AND "receivedAt" <= ${to}
                GROUP BY idx
                ORDER BY idx ASC
            `,
        );
    }

    private requestSeries(
        appId: string,
        from: Date,
        to: Date,
        bucketSeconds: number,
    ) {
        return this.prisma.$queryRaw<RequestSeriesRow[]>(
            Prisma.sql`
                SELECT
                    FLOOR(EXTRACT(EPOCH FROM ("receivedAt" - ${from})) / ${bucketSeconds})::int AS idx,
                    COUNT(*)::bigint AS total,
                    COUNT(*) FILTER (WHERE NOT "success")::bigint AS failures
                FROM "rum_perf_samples"
                WHERE "appId" = ${appId}
                  AND "metric"::text = 'HTTP'
                  AND "receivedAt" >= ${from}
                  AND "receivedAt" <= ${to}
                GROUP BY idx
                ORDER BY idx ASC
            `,
        );
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
    events: EventSeriesRow[],
    requests: RequestSeriesRow[],
    errors: ErrorSeriesRow[],
) {
    const bucketMs = bucketMinutes * 60_000;
    const bucketCount = Math.max(1, Math.floor(rangeMs / bucketMs) + 1);
    const series = Array.from({ length: bucketCount }, (_, index) => ({
        bucketStart: new Date(from.getTime() + index * bucketMs),
        pv: 0,
        uv: 0,
        clicks: 0,
        requests: 0,
        failures: 0,
        jsErrors: 0,
        customErrors: 0,
        events: 0,
    }));
    for (const row of events) {
        const target = series[row.idx];
        if (!target) continue;
        target.pv = Number(row.pv);
        target.uv = Number(row.uv);
        target.clicks = Number(row.clicks);
        target.events = Number(row.events);
    }
    for (const row of requests) {
        const target = series[row.idx];
        if (!target) continue;
        target.requests = Number(row.total);
        target.failures = Number(row.failures);
    }
    for (const row of errors) {
        const target = series[row.idx];
        if (!target) continue;
        target.jsErrors = Number(row.js);
        target.customErrors = Number(row.custom);
    }
    return series;
}
