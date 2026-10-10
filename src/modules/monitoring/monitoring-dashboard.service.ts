import { Injectable, NotFoundException } from '@nestjs/common';
import { Temporal } from '@js-temporal/polyfill';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/database/prisma.service';
import { MultiLevelCacheService } from '../../infra/cache/multi-level-cache.service';
import { SystemProbeScheduler } from '../admin/system-probes/system-probe-scheduler';
import {
    QueryMonitoringAvailabilityDto,
    QueryMonitoringDashboardDto,
    QueryMonitoringStatusCodesDto,
} from './dto/query-monitoring.dto';
import {
    coverageStatus,
    DAY_MS,
    HOUR_MS,
    iso,
    localHourIntervals,
    monitoringWindow,
    roundPercent,
    zoned,
} from './monitoring-window.util';

type Tx = Prisma.TransactionClient;
type Metrics = {
    checks: number;
    failures: number;
    avg: number | null;
    p50: number | null;
    p95: number | null;
    p99: number | null;
};
type Group = Metrics & { key: number };
const EMPTY: Metrics = {
    checks: 0,
    failures: 0,
    avg: null,
    p50: null,
    p95: null,
    p99: null,
};
const aggregate = Prisma.sql`
    COUNT(*)::integer AS checks, COUNT(*) FILTER (WHERE NOT success)::integer AS failures,
    AVG(latency)::float8 AS avg,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY latency)::float8 AS p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY latency)::float8 AS p95,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY latency)::float8 AS p99`;
const latency = (value: number | null) =>
    value === null ? null : Math.round(value);
const uptime = (row: Metrics) =>
    row.checks ? (100 * (row.checks - row.failures)) / row.checks : null;
const failureRate = (row: Metrics) =>
    row.checks ? (100 * row.failures) / row.checks : null;
const displayPercent = (value: number | null) =>
    value === null ? null : roundPercent(value);
const maximumDate = (a: Date, b: Date) =>
    new Date(Math.max(a.getTime(), b.getTime()));

@Injectable()
export class MonitoringDashboardService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly cache: MultiLevelCacheService,
        private readonly probes: SystemProbeScheduler,
    ) {}

    async assertProject(projectId: string) {
        const project = await this.prisma.project.findFirst({
            where: {
                id: projectId,
                deletedAt: null,
                organization: { deletedAt: null },
            },
        });
        if (!project) throw new NotFoundException('Project not found');
        return project;
    }

    private async cached<T>(
        projectId: string,
        name: string,
        query: object,
        ttl: number,
        build: (tx: Tx, asOf: Date) => Promise<T>,
        prepare?: () => Promise<void>,
    ) {
        await this.assertProject(projectId);
        return this.cache.getOrSet(
            `monitoring:v1:${projectId}:${name}:${JSON.stringify(query)}`,
            async () => {
                await prepare?.();
                return this.prisma.$transaction(
                    async (tx) => {
                        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
                        const [clock] = await tx.$queryRaw<
                            { at: Date }[]
                        >`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at`;
                        return build(tx, clock.at);
                    },
                    { isolationLevel: 'RepeatableRead', timeout: 30_000 },
                );
            },
            ttl,
            { l1Ttl: ttl },
        );
    }

    private async coverage(tx: Tx, projectId: string, asOf: Date) {
        const row = await tx.monitoringCoverage.findUniqueOrThrow({
            where: { projectId },
        });
        const cutoff = new Date(asOf.getTime() - 90 * DAY_MS);
        return {
            checks: maximumDate(row.checksStartedAt, cutoff),
            counts: maximumDate(row.countsStartedAt, cutoff),
            probes: maximumDate(row.probeStartedAt, cutoff),
            alerts: maximumDate(row.alertsStartedAt, cutoff),
        };
    }

    private async metrics(tx: Tx, projectId: string, from: Date, to: Date) {
        const rows = await tx.$queryRaw<
            Metrics[]
        >`SELECT ${aggregate} FROM check_logs
            WHERE "projectId" = ${projectId} AND source = 'LOCAL'
            AND "checkedAt" >= ${from} AND "checkedAt" < ${to}`;
        return rows[0] ?? EMPTY;
    }

    private async groups(
        tx: Tx,
        projectId: string,
        from: Date,
        to: Date,
        first: number,
        step: number,
        monitorIds?: string[],
    ) {
        if (monitorIds && !monitorIds.length)
            return [] as (Group & { monitorId: string })[];
        return tx.$queryRaw<(Group & { monitorId: string })[]>`SELECT
            floor((extract(epoch FROM "checkedAt") * 1000 - ${first}::float8) / ${step}::float8)::integer AS key,
            ${monitorIds ? Prisma.sql`"monitorId"` : Prisma.sql`''::text`} AS "monitorId",
            ${aggregate} FROM check_logs WHERE "projectId" = ${projectId}
            AND source = 'LOCAL' AND "checkedAt" >= ${from} AND "checkedAt" < ${to}
            ${monitorIds ? Prisma.sql`AND "monitorId" IN (${Prisma.join(monitorIds)})` : Prisma.empty}
            GROUP BY key ${monitorIds ? Prisma.sql`, "monitorId"` : Prisma.empty}`;
    }

    private async counts(tx: Tx, projectId: string, times: Date[]) {
        if (!times.length) return [];
        return tx.$queryRaw<{ key: number; total: number; failing: number }[]>`
            SELECT p.key, COUNT(h."monitorId") FILTER (WHERE NOT h.deleted)::integer AS total,
                COUNT(h."monitorId") FILTER (WHERE NOT h.deleted AND h.enabled AND h.status IN ('DOWN','DEGRADED'))::integer AS failing
            FROM (VALUES ${Prisma.join(times.map((at, index) => Prisma.sql`(${index}::integer, ${at}::timestamp)`))}) p(key,at)
            LEFT JOIN LATERAL (
                SELECT DISTINCT ON ("monitorId") "monitorId",deleted,enabled,status
                FROM monitor_history WHERE "projectId" = ${projectId}
                AND ("effectiveAt" < p.at OR (cause = 'BASELINE' AND "effectiveAt" = p.at))
                ORDER BY "monitorId","effectiveAt" DESC,revision DESC
            ) h ON true GROUP BY p.key ORDER BY p.key`;
    }

    async dashboard(projectId: string, query: QueryMonitoringDashboardDto) {
        let assigned: string[] = [];
        return this.cached(
            projectId,
            'dashboard',
            query,
            30,
            async (tx, asOf) => {
                const { tz, range, slowLimit, alertLimit } = query;
                const window = monitoringWindow(asOf, range, tz);
                const water = await this.coverage(tx, projectId, asOf);
                const monitors = await tx.monitor.findMany({
                    where: { projectId, deletedAt: null },
                    include: { state: true },
                });
                const current = await this.metrics(
                    tx,
                    projectId,
                    maximumDate(window.from, water.checks),
                    asOf,
                );
                const previous =
                    window.previousFrom && window.previousTo
                        ? await this.metrics(
                              tx,
                              projectId,
                              maximumDate(window.previousFrom, water.checks),
                              window.previousTo,
                          )
                        : EMPTY;
                const currentStatus = coverageStatus(
                    window.from,
                    water.checks,
                    current.checks,
                );
                const previousStatus = coverageStatus(
                    window.previousFrom,
                    water.checks,
                    previous.checks,
                );
                const complete = currentStatus !== 'TRUNCATED';
                const comparable =
                    complete &&
                    previousStatus === 'AVAILABLE' &&
                    currentStatus === 'AVAILABLE';
                const byStatus = {
                    total: monitors.length,
                    up: 0,
                    down: 0,
                    degraded: 0,
                    paused: 0,
                    unknown: 0,
                };
                for (const m of monitors) {
                    const status = !m.enabled
                        ? 'paused'
                        : !m.state ||
                            ['UNKNOWN', 'PAUSED'].includes(m.state.status)
                          ? 'unknown'
                          : (m.state.status.toLowerCase() as
                                'up' | 'down' | 'degraded');
                    byStatus[status]++;
                }
                const hasHistory =
                    monitors.length ||
                    (await tx.monitorHistory.count({ where: { projectId } }));
                const grid =
                    hasHistory || window.from < water.counts
                        ? window.buckets
                        : [];
                const groups = await this.groups(
                    tx,
                    projectId,
                    maximumDate(window.from, water.checks),
                    asOf,
                    window.first,
                    window.step,
                );
                const countRows = await this.counts(tx, projectId, [
                    window.from,
                    ...grid.map((b) => b.to),
                ]);
                const points = grid.map((bucket, index) => {
                    const row =
                        groups.find(
                            (g) =>
                                g.key ===
                                Math.floor(
                                    (bucket.start.getTime() - window.first) /
                                        window.step,
                                ),
                        ) ?? EMPTY;
                    const covered = bucket.from >= water.checks;
                    const count = countRows[index + 1];
                    return {
                        time: iso(bucket.start, tz),
                        durationSeconds: bucket.durationSeconds,
                        checks: covered ? row.checks : null,
                        failures: covered ? row.failures : null,
                        checksPerMinute: covered
                            ? roundPercent(
                                  (row.checks * 60) / bucket.durationSeconds,
                              )
                            : null,
                        avgLatencyMs: covered ? latency(row.avg) : null,
                        latencyP50Ms: covered ? latency(row.p50) : null,
                        latencyP95Ms: covered ? latency(row.p95) : null,
                        latencyP99Ms: covered ? latency(row.p99) : null,
                        uptimePercent: covered
                            ? displayPercent(uptime(row))
                            : null,
                        monitorCount:
                            bucket.to >= water.counts
                                ? (count?.total ?? 0)
                                : null,
                        failingCount:
                            bucket.to >= water.counts
                                ? (count?.failing ?? 0)
                                : null,
                    };
                });
                const probeRows = await tx.probe.findMany({
                    where: {
                        OR: [
                            {
                                scope: 'TENANT',
                                monitors: {
                                    some: {
                                        monitorId: {
                                            in: monitors.map((m) => m.id),
                                        },
                                    },
                                },
                            },
                            { scope: 'SYSTEM', id: { in: assigned } },
                        ],
                    },
                    orderBy: [{ name: 'asc' }, { id: 'asc' }],
                    select: {
                        id: true,
                        name: true,
                        scope: true,
                        region: true,
                        enabled: true,
                        status: true,
                    },
                });
                const probeStats = await tx.probeResult.groupBy({
                    by: ['probeId'],
                    where: {
                        projectId,
                        checkedAt: {
                            gte: maximumDate(window.from, water.probes),
                            lt: asOf,
                        },
                    },
                    _avg: { latency: true },
                    _count: { _all: true },
                });
                const probeSamples = probeStats.reduce(
                    (sum, p) => sum + p._count._all,
                    0,
                );
                const probeDistribution = probeRows.map((p) => ({
                    id: p.id,
                    scope: p.scope,
                    name:
                        p.scope === 'SYSTEM' ? `System (${p.region})` : p.name,
                    region: p.region,
                    enabled: p.enabled,
                    online: p.enabled && p.status === 'ONLINE',
                    latencyMs:
                        p.enabled &&
                        p.status === 'ONLINE' &&
                        window.from >= water.probes
                            ? latency(
                                  probeStats.find((s) => s.probeId === p.id)
                                      ?._avg.latency ?? null,
                              )
                            : null,
                }));
                const histogram =
                    complete && current.checks
                        ? await tx.$queryRaw<{ key: number; count: number }[]>`
                SELECT CASE WHEN latency < 100 THEN 0 WHEN latency < 200 THEN 1
                    WHEN latency < 300 THEN 2 WHEN latency < 500 THEN 3 WHEN latency < 1000 THEN 4 ELSE 5 END AS key,
                    COUNT(*)::integer AS count FROM check_logs WHERE "projectId" = ${projectId}
                    AND source = 'LOCAL' AND "checkedAt" >= ${window.from} AND "checkedAt" < ${asOf} GROUP BY key`
                        : [];
                const slow = complete
                    ? await tx.$queryRaw<(Metrics & { id: string })[]>`
                SELECT c."monitorId" AS id, ${aggregate} FROM check_logs c
                WHERE c."projectId" = ${projectId} AND c.source = 'LOCAL'
                AND c."checkedAt" >= ${window.from} AND c."checkedAt" < ${asOf}
                AND EXISTS (SELECT 1 FROM monitors m WHERE m.id = c."monitorId" AND m."deletedAt" IS NULL)
                GROUP BY c."monitorId" ORDER BY avg DESC,c."monitorId" ASC LIMIT ${slowLimit}`
                    : [];
                const slowGroups = await this.groups(
                    tx,
                    projectId,
                    window.from,
                    asOf,
                    window.first,
                    window.step,
                    slow.map((s) => s.id),
                );
                const alertRows = await tx.alertEvent.findMany({
                    where: {
                        projectId,
                        updatedAt: {
                            gte: maximumDate(window.from, water.alerts),
                            lt: asOf,
                        },
                    },
                    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
                    take: alertLimit,
                });
                const ongoing = await tx.alertEvent.count({
                    where: {
                        projectId,
                        status: 'ongoing',
                        monitorId: { in: monitors.map((m) => m.id) },
                    },
                });
                const expired = monitors
                    .filter(
                        (m) =>
                            m.checkSsl &&
                            m.state?.sslExpiresAt &&
                            m.state.sslExpiresAt > asOf &&
                            m.state.sslExpiresAt.getTime() <=
                                asOf.getTime() + 30 * DAY_MS,
                    )
                    .sort(
                        (a, b) =>
                            a.state!.sslExpiresAt!.getTime() -
                                b.state!.sslExpiresAt!.getTime() ||
                            a.id.localeCompare(b.id),
                    );
                const countsKnown = window.from >= water.counts;
                const delta = (
                    a: number | null,
                    b: number | null,
                    percentage = false,
                ) =>
                    comparable && a !== null && b !== null
                        ? percentage
                            ? roundPercent(a - b)
                            : Math.round(a - b)
                        : null;
                const previousProbeCount =
                    window.previousFrom && window.previousTo
                        ? await tx.probeResult.count({
                              where: {
                                  projectId,
                                  checkedAt: {
                                      gte: maximumDate(
                                          window.previousFrom,
                                          water.probes,
                                      ),
                                      lt: window.previousTo,
                                  },
                              },
                          })
                        : 0;
                const previousAlerts =
                    window.previousFrom && window.previousTo
                        ? await tx.alertEvent.count({
                              where: {
                                  projectId,
                                  updatedAt: {
                                      gte: maximumDate(
                                          window.previousFrom,
                                          water.alerts,
                                      ),
                                      lt: window.previousTo,
                                  },
                              },
                          })
                        : 0;
                return {
                    range,
                    tz,
                    asOf: iso(asOf, tz),
                    from: iso(window.from, tz),
                    to: iso(asOf, tz),
                    previousFrom: window.previousFrom
                        ? iso(window.previousFrom, tz)
                        : null,
                    previousTo: window.previousTo
                        ? iso(window.previousTo, tz)
                        : null,
                    metricBasis: {
                        sampleSource: 'LOCAL',
                        availability: 'EFFECTIVE_SUCCESS',
                        latency: 'LOCAL_DURATION',
                    },
                    history: {
                        retentionDays: 90,
                        availableFrom: iso(water.checks, tz),
                        countsAvailableFrom: iso(water.counts, tz),
                        probeAvailableFrom: iso(water.probes, tz),
                        alertsAvailableFrom: iso(water.alerts, tz),
                        current: currentStatus,
                        previous: previousStatus,
                        countsCurrent: countsKnown ? 'AVAILABLE' : 'TRUNCATED',
                        countsPrevious: window.previousFrom
                            ? window.previousFrom >= water.counts
                                ? 'AVAILABLE'
                                : 'TRUNCATED'
                            : 'UNAVAILABLE',
                        probeCurrent: coverageStatus(
                            window.from,
                            water.probes,
                            probeSamples,
                        ),
                        probePrevious: coverageStatus(
                            window.previousFrom,
                            water.probes,
                            previousProbeCount,
                        ),
                        alertsCurrent: coverageStatus(
                            window.from,
                            water.alerts,
                            alertRows.length,
                        ),
                        alertsPrevious: coverageStatus(
                            window.previousFrom,
                            water.alerts,
                            previousAlerts,
                        ),
                    },
                    summary: {
                        monitors: byStatus,
                        probes: {
                            scope: 'PROJECT_ASSIGNED',
                            total: probeRows.length,
                            online: probeDistribution.filter((p) => p.online)
                                .length,
                        },
                        alertingCount: ongoing,
                        sslExpiringCount: expired.length,
                        expiringCertificates: expired.slice(0, 3).map((m) => ({
                            monitorId: m.id,
                            host: new URL(m.target).hostname,
                            expiresAt: iso(m.state!.sslExpiresAt!, tz),
                            daysLeft: Math.ceil(
                                (m.state!.sslExpiresAt!.getTime() -
                                    asOf.getTime()) /
                                    DAY_MS,
                            ),
                            issuer: m.state!.sslIssuer,
                        })),
                    },
                    kpis: {
                        totalChecks: complete ? current.checks : null,
                        failedChecks: complete ? current.failures : null,
                        uptimePercent: complete
                            ? displayPercent(uptime(current))
                            : null,
                        uptimeDeltaPercent: delta(
                            uptime(current),
                            uptime(previous),
                            true,
                        ),
                        avgLatencyMs: complete ? latency(current.avg) : null,
                        avgLatencyDeltaMs: delta(current.avg, previous.avg),
                        p95LatencyMs: complete ? latency(current.p95) : null,
                        p95LatencyDeltaMs: delta(current.p95, previous.p95),
                        failureRatePercent: complete
                            ? displayPercent(failureRate(current))
                            : null,
                        failureRateDeltaPercent: delta(
                            failureRate(current),
                            failureRate(previous),
                            true,
                        ),
                        monitorCount: byStatus.total,
                        monitorDelta: countsKnown
                            ? byStatus.total - (countRows[0]?.total ?? 0)
                            : null,
                        failingCount: byStatus.down + byStatus.degraded,
                        failingDelta: countsKnown
                            ? byStatus.down +
                              byStatus.degraded -
                              (countRows[0]?.failing ?? 0)
                            : null,
                    },
                    timeline: { interval: window.interval, points },
                    sparklines: {
                        uptime: points.map((p) => p.uptimePercent),
                        avgLatency: points.map((p) => p.avgLatencyMs),
                        p95Latency: points.map((p) => p.latencyP95Ms),
                        failureRate: points.map((p) =>
                            p.checks
                                ? roundPercent((100 * p.failures!) / p.checks)
                                : null,
                        ),
                        monitorCount: points.map((p) => p.monitorCount),
                        failing: points.map((p) => p.failingCount),
                    },
                    distribution: {
                        protocols: ['HTTP', 'TCP']
                            .map((type) => ({
                                type,
                                count: monitors.filter((m) => m.type === type)
                                    .length,
                            }))
                            .filter((p) => p.count),
                        probes: probeDistribution,
                        latencyHistogram: {
                            unit: 'ms',
                            buckets: histogram.length
                                ? [0, 100, 200, 300, 500, 1000].map(
                                      (from, index, all) => ({
                                          from,
                                          to: all[index + 1] ?? null,
                                          count:
                                              histogram.find(
                                                  (b) => b.key === index,
                                              )?.count ?? 0,
                                      }),
                                  )
                                : [],
                        },
                    },
                    slowestMonitors: slow.map((s) => {
                        const m = monitors.find((m) => m.id === s.id)!;
                        return {
                            id: s.id,
                            name: m.name,
                            target: m.target,
                            type: m.type,
                            avgLatencyMs: latency(s.avg),
                            p95LatencyMs: latency(s.p95),
                            uptimePercent: displayPercent(uptime(s)),
                            sparkline: grid.map((b) =>
                                latency(
                                    slowGroups.find(
                                        (g) =>
                                            g.monitorId === s.id &&
                                            g.key ===
                                                Math.floor(
                                                    (b.start.getTime() -
                                                        window.first) /
                                                        window.step,
                                                ),
                                    )?.avg ?? null,
                                ),
                            ),
                        };
                    }),
                    recentAlerts: alertRows.map((event) => ({
                        id: event.id,
                        monitorId: event.monitorId,
                        monitorName: event.monitorName,
                        target: event.target,
                        monitorDeleted: !monitors.some(
                            (m) => m.id === event.monitorId,
                        ),
                        kind: event.kind,
                        level: event.level,
                        status: event.status,
                        suppressedReason: event.suppressedReason,
                        reason: event.reason,
                        threshold: event.threshold,
                        actual: event.actual,
                        unit: event.unit,
                        message: event.message,
                        startedAt: iso(event.startedAt, tz),
                        resolvedAt: event.resolvedAt
                            ? iso(event.resolvedAt, tz)
                            : null,
                        updatedAt: iso(event.updatedAt, tz),
                        durationSeconds: event.durationSeconds,
                        notified: !!event.firstNotifiedAt,
                    })),
                };
            },
            async () => {
                const candidates = await this.prisma.monitor.findMany({
                    where: { projectId, deletedAt: null },
                    select: { id: true },
                });
                assigned = candidates.length
                    ? await this.probes.getAssignmentsForMonitors(
                          candidates.map((m) => m.id),
                      )
                    : [];
            },
        );
    }

    async availability(
        projectId: string,
        query: QueryMonitoringAvailabilityDto,
    ) {
        return this.cached(
            projectId,
            'availability',
            query,
            300,
            async (tx, asOf) => {
                const { tz, days: count } = query;
                const today = zoned(asOf, tz).toPlainDate();
                const days = Array.from({ length: count }, (_, i) =>
                    today.subtract({ days: count - i - 1 }).toString(),
                );
                const earliest = Temporal.PlainDate.from(
                    days[0],
                ).toZonedDateTime(tz);
                const from = new Date(earliest.epochMilliseconds);
                const water = await this.coverage(tx, projectId, asOf);
                const rows = await tx.$queryRaw<
                    {
                        day: string;
                        hour: number;
                        checks: number;
                        successes: number;
                    }[]
                >`
                SELECT to_char("checkedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz},'YYYY-MM-DD') AS day,
                extract(hour FROM "checkedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::integer AS hour,
                COUNT(*)::integer AS checks, COUNT(*) FILTER (WHERE success)::integer AS successes
                FROM check_logs WHERE "projectId" = ${projectId} AND source = 'LOCAL'
                AND "checkedAt" >= ${maximumDate(from, water.checks)} AND "checkedAt" < ${asOf} GROUP BY day,hour`;
                const unavailableCells: number[][] = [];
                const cells: number[][] = [];
                days.forEach((day, index) => {
                    const intervals = localHourIntervals(day, tz, asOf);
                    for (let hour = 0; hour < 24; hour++) {
                        const selected = intervals.filter(
                            (i) => i.hour === hour,
                        );
                        if (!selected.length) continue;
                        if (selected.some((i) => i.from < water.checks)) {
                            unavailableCells.push([hour, index]);
                            continue;
                        }
                        const row = rows.find(
                            (r) => r.day === day && r.hour === hour,
                        );
                        if (row)
                            cells.push([
                                hour,
                                index,
                                roundPercent(
                                    (100 * row.successes) / row.checks,
                                ),
                            ]);
                    }
                });
                const worst = [...cells].sort(
                    (a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0],
                )[0];
                return {
                    tz,
                    asOf: iso(asOf, tz),
                    from: days[0],
                    to: days[days.length - 1],
                    history: {
                        retentionDays: 90,
                        availableFrom: iso(water.checks, tz),
                        status: from < water.checks ? 'TRUNCATED' : 'AVAILABLE',
                    },
                    hours: Array.from({ length: 24 }, (_, i) => i),
                    days,
                    cells,
                    unavailableCells,
                    worst: worst
                        ? {
                              day: days[worst[1]],
                              hour: worst[0],
                              value: worst[2],
                          }
                        : null,
                };
            },
        );
    }

    async statusCodes(projectId: string, query: QueryMonitoringStatusCodesDto) {
        return this.cached(
            projectId,
            'status-codes',
            query,
            60,
            async (tx, asOf) => {
                const { tz, hours } = query;
                const first =
                    Math.floor(asOf.getTime() / HOUR_MS) * HOUR_MS -
                    (hours - 1) * HOUR_MS;
                const from = new Date(first);
                const water = await this.coverage(tx, projectId, asOf);
                const starts = Array.from(
                    { length: hours },
                    (_, i) => new Date(first + i * HOUR_MS),
                );
                const unavailableBuckets = starts
                    .filter((at) => at < water.checks)
                    .map((at) => iso(at, tz));
                const validFrom = starts.find((at) => at >= water.checks);
                const rows = validFrom
                    ? await tx.$queryRaw<
                          {
                              key: number;
                              httpChecks: number;
                              success2xx: number;
                              redirect3xx: number;
                              clientError4xx: number;
                              serverError5xx: number;
                              otherStatusCode: number;
                              noStatusCode: number;
                          }[]
                      >`
                SELECT floor((extract(epoch FROM "checkedAt")*1000 - ${first}::float8)/${HOUR_MS}::float8)::integer AS key,
                COUNT(*)::integer AS "httpChecks",
                COUNT(*) FILTER (WHERE "statusCode" >= 200 AND "statusCode" < 300)::integer AS "success2xx",
                COUNT(*) FILTER (WHERE "statusCode" >= 300 AND "statusCode" < 400)::integer AS "redirect3xx",
                COUNT(*) FILTER (WHERE "statusCode" >= 400 AND "statusCode" < 500)::integer AS "clientError4xx",
                COUNT(*) FILTER (WHERE "statusCode" >= 500 AND "statusCode" < 600)::integer AS "serverError5xx",
                COUNT(*) FILTER (WHERE "statusCode" IS NOT NULL AND ("statusCode" < 200 OR "statusCode" >= 600))::integer AS "otherStatusCode",
                COUNT(*) FILTER (WHERE "statusCode" IS NULL)::integer AS "noStatusCode"
                FROM check_logs WHERE "projectId" = ${projectId} AND source = 'LOCAL' AND "monitorType" = 'HTTP'
                AND "checkedAt" >= ${validFrom} AND "checkedAt" < ${asOf} GROUP BY key ORDER BY key`
                    : [];
                const unclassifiedChecks = validFrom
                    ? await tx.checkLog.count({
                          where: {
                              projectId,
                              source: 'LOCAL',
                              monitorType: null,
                              checkedAt: { gte: validFrom, lt: asOf },
                          },
                      })
                    : 0;
                return {
                    tz,
                    asOf: iso(asOf, tz),
                    from: iso(from, tz),
                    to: iso(asOf, tz),
                    history: {
                        retentionDays: 90,
                        availableFrom: iso(water.checks, tz),
                        status: from < water.checks ? 'TRUNCATED' : 'AVAILABLE',
                    },
                    unclassifiedChecks,
                    unavailableBuckets,
                    buckets: rows.length
                        ? starts.flatMap((at, index) => {
                              if (at < water.checks) return [];
                              const row = rows.find((r) => r.key === index);
                              return [
                                  {
                                      time: iso(at, tz),
                                      httpChecks: row?.httpChecks ?? 0,
                                      success2xx: row?.success2xx ?? 0,
                                      redirect3xx: row?.redirect3xx ?? 0,
                                      clientError4xx: row?.clientError4xx ?? 0,
                                      serverError5xx: row?.serverError5xx ?? 0,
                                      otherStatusCode:
                                          row?.otherStatusCode ?? 0,
                                      noStatusCode: row?.noStatusCode ?? 0,
                                  },
                              ];
                          })
                        : [],
                };
            },
        );
    }
}
