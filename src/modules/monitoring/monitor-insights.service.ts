import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/database/prisma.service';
import { QueryMonitorInsightsDto } from './dto/query-monitor-insights.dto';
import {
    coverageStatus,
    DAY_MS,
    HOUR_MS,
    iso,
    roundPercent,
} from './monitoring-window.util';

type Metrics = {
    checks: number;
    failures: number;
    rescued: number;
    avg: number | null;
    p50: number | null;
    p95: number | null;
    p99: number | null;
};
const metricsSql = Prisma.sql`
    COUNT(*)::integer AS checks,
    COUNT(*) FILTER (WHERE NOT success)::integer AS failures,
    COUNT(*) FILTER (WHERE "rescuedByProbe")::integer AS rescued,
    AVG(latency)::float8 AS avg,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY latency)::float8 AS p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY latency)::float8 AS p95,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY latency)::float8 AS p99`;
const empty: Metrics = {
    checks: 0,
    failures: 0,
    rescued: 0,
    avg: null,
    p50: null,
    p95: null,
    p99: null,
};
const rounded = (value: number | null) =>
    value === null ? null : Math.round(value);
const percent = (row: Metrics) =>
    row.checks
        ? roundPercent((100 * (row.checks - row.failures)) / row.checks)
        : null;
const later = (...dates: Date[]) =>
    new Date(Math.max(...dates.map((date) => date.getTime())));

@Injectable()
export class MonitorInsightsService {
    constructor(private readonly prisma: PrismaService) {}

    async get(
        projectId: string,
        monitorId: string,
        query: QueryMonitorInsightsDto,
    ) {
        return this.prisma.$transaction(
            async (tx) => {
                await tx.$executeRaw`SET TRANSACTION READ ONLY`;
                const [clock] = await tx.$queryRaw<
                    { at: Date }[]
                >`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at`;
                const asOf = clock.at;
                const monitor = await tx.monitor.findFirst({
                    where: {
                        id: monitorId,
                        projectId,
                        deletedAt: null,
                        project: {
                            deletedAt: null,
                            organization: { deletedAt: null },
                        },
                    },
                    select: {
                        id: true,
                        createdAt: true,
                        enabled: true,
                        checkSsl: true,
                        sslExpiryThreshold: true,
                        state: true,
                    },
                });
                if (!monitor)
                    throw new NotFoundException(
                        'Monitor not found in this project',
                    );
                const water = await tx.monitoringCoverage.findUniqueOrThrow({
                    where: { projectId },
                });
                const { range, tz } = query;
                const spans = {
                    '1h': HOUR_MS,
                    '24h': DAY_MS,
                    '7d': 7 * DAY_MS,
                    '30d': 30 * DAY_MS,
                };
                const steps = {
                    '1h': 120000,
                    '24h': HOUR_MS,
                    '7d': 6 * HOUR_MS,
                    '30d': DAY_MS,
                };
                const from = new Date(asOf.getTime() - spans[range]);
                const step = steps[range];
                const first = Math.floor(from.getTime() / step) * step;
                const availableFrom = later(
                    water.checksStartedAt,
                    new Date(asOf.getTime() - 90 * DAY_MS),
                );
                const alertsAvailableFrom = later(
                    water.alertsStartedAt,
                    new Date(asOf.getTime() - 90 * DAY_MS),
                );
                // Time before creation is known empty; time before reliable collection is unknown.
                const existedFrom = later(from, monitor.createdAt);
                const sampleFrom = later(existedFrom, availableFrom);
                const [totals] = await tx.$queryRaw<Metrics[]>`
                SELECT ${metricsSql} FROM check_logs WHERE "projectId" = ${projectId}
                AND "monitorId" = ${monitorId} AND source = 'LOCAL'
                AND "checkedAt" >= ${sampleFrom} AND "checkedAt" < ${asOf}`;
                const groups = await tx.$queryRaw<
                    (Metrics & { key: number })[]
                >`
                SELECT floor((extract(epoch FROM "checkedAt") * 1000 - ${first}::float8) / ${step}::float8)::integer AS key,
                ${metricsSql} FROM check_logs WHERE "projectId" = ${projectId}
                AND "monitorId" = ${monitorId} AND source = 'LOCAL'
                AND "checkedAt" >= ${sampleFrom} AND "checkedAt" < ${asOf} GROUP BY key`;
                const byKey = new Map(groups.map((row) => [row.key, row]));
                const total = totals ?? empty;
                const status = coverageStatus(
                    existedFrom,
                    availableFrom,
                    total.checks,
                );
                const complete = status !== 'TRUNCATED';
                const points: {
                    time: string;
                    durationSeconds: number;
                    checks: number | null;
                    failures: number | null;
                    avgLatencyMs: number | null;
                    latencyP50Ms: number | null;
                    latencyP95Ms: number | null;
                    latencyP99Ms: number | null;
                    uptimePercent: number | null;
                }[] = [];
                for (
                    let time = first, key = 0;
                    time < asOf.getTime();
                    time += step, key++
                ) {
                    const begin = new Date(Math.max(time, from.getTime()));
                    const end = new Date(Math.min(time + step, asOf.getTime()));
                    const row = byKey.get(key) ?? empty;
                    const known =
                        end <= monitor.createdAt ||
                        later(begin, monitor.createdAt) >= availableFrom;
                    points.push({
                        time: iso(new Date(time), tz),
                        durationSeconds:
                            (end.getTime() - begin.getTime()) / 1000,
                        checks: known ? row.checks : null,
                        failures: known ? row.failures : null,
                        avgLatencyMs: known ? rounded(row.avg) : null,
                        latencyP50Ms: known ? rounded(row.p50) : null,
                        latencyP95Ms: known ? rounded(row.p95) : null,
                        latencyP99Ms: known ? rounded(row.p99) : null,
                        uptimePercent: known ? percent(row) : null,
                    });
                }
                const checks = await tx.checkLog.findMany({
                    where: {
                        projectId,
                        monitorId,
                        source: 'LOCAL',
                        checkedAt: { gte: sampleFrom, lt: asOf },
                    },
                    orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }],
                    take: 50,
                    select: {
                        id: true,
                        success: true,
                        localSuccess: true,
                        rescuedByProbe: true,
                        latency: true,
                        statusCode: true,
                        error: true,
                        source: true,
                        checkedAt: true,
                    },
                });
                const events = await tx.alertEvent.findMany({
                    where: {
                        projectId,
                        monitorId,
                        startedAt: { lt: asOf },
                        OR: [
                            { status: 'ongoing' },
                            {
                                updatedAt: {
                                    gte: later(
                                        existedFrom,
                                        alertsAvailableFrom,
                                    ),
                                    lt: asOf,
                                },
                            },
                        ],
                    },
                    orderBy: [
                        { status: 'asc' },
                        { updatedAt: 'desc' },
                        { id: 'desc' },
                    ],
                    take: 20,
                });
                const ongoingCount = await tx.alertEvent.count({
                    where: { projectId, monitorId, status: 'ongoing' },
                });
                const state = monitor.state;
                return {
                    monitorId,
                    range,
                    tz,
                    asOf: iso(asOf, tz),
                    from: iso(from, tz),
                    to: iso(asOf, tz),
                    metricBasis: {
                        sampleSource: 'LOCAL' as const,
                        availability: 'EFFECTIVE_SUCCESS' as const,
                        latency: 'LOCAL_DURATION' as const,
                    },
                    history: {
                        retentionDays: 90,
                        availableFrom: iso(availableFrom, tz),
                        status,
                        alertsAvailableFrom: iso(alertsAvailableFrom, tz),
                        alertsStatus: coverageStatus(
                            existedFrom,
                            alertsAvailableFrom,
                            events.length,
                        ),
                    },
                    latest: {
                        status: !monitor.enabled
                            ? 'PAUSED'
                            : state?.status === 'PAUSED'
                              ? 'UNKNOWN'
                              : (state?.status ?? 'UNKNOWN'),
                        failCount: state?.failCount ?? 0,
                        lastCheckAt: state?.lastCheckAt
                            ? iso(state.lastCheckAt, tz)
                            : null,
                        lastLatency: state?.lastLatency ?? null,
                        lastError: state?.lastError ?? null,
                        ongoingCount,
                    },
                    metrics: {
                        totalChecks: complete ? total.checks : null,
                        failedChecks: complete ? total.failures : null,
                        rescuedChecks: complete ? total.rescued : null,
                        uptimePercent: complete ? percent(total) : null,
                        avgLatencyMs: complete ? rounded(total.avg) : null,
                        p50LatencyMs: complete ? rounded(total.p50) : null,
                        p95LatencyMs: complete ? rounded(total.p95) : null,
                        p99LatencyMs: complete ? rounded(total.p99) : null,
                    },
                    timeline: {
                        interval:
                            range === '1h'
                                ? '2m'
                                : range === '7d'
                                  ? '6h'
                                  : range === '30d'
                                    ? '24h'
                                    : '1h',
                        points,
                    },
                    checks: checks.map((log) => ({
                        ...log,
                        checkedAt: iso(log.checkedAt, tz),
                    })),
                    checksLimit: 50,
                    eventsLimit: 20,
                    events: events.map((event) => ({
                        id: event.id,
                        monitorId: event.monitorId,
                        monitorName: event.monitorName,
                        target: event.target,
                        monitorDeleted: false,
                        kind: event.kind,
                        level: event.level,
                        status: event.status,
                        origin: event.origin,
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
            { isolationLevel: 'RepeatableRead', timeout: 15000 },
        );
    }
}
