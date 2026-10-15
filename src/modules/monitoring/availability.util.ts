import { Temporal } from '@js-temporal/polyfill';
import { Prisma } from '../../generated/prisma/client';
import {
    DAY_MS,
    iso,
    localHourIntervals,
    roundPercent,
    zoned,
} from './monitoring-window.util';

/** Retention applied to `check_logs`; mirrors the cleanup job. */
export const AVAILABILITY_RETENTION_DAYS = 90;

/** Hour axis of one day bucket: local hours 0-23, never 24. */
export const AVAILABILITY_HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** One aggregated (local date, local hour) bucket of LOCAL check samples. */
export interface HourlyAvailabilityRow {
    day: string;
    hour: number;
    checks: number;
    successes: number;
}

/** The same bucket, tagged with the monitor it was aggregated for. */
export interface MonitorHourlyAvailabilityRow extends HourlyAvailabilityRow {
    monitorId: string;
}

/** Consecutive local calendar days ending today, oldest first. */
export function availabilityDays(
    tz: string,
    asOf: Date,
    days: number,
): string[] {
    const today = zoned(asOf, tz).toPlainDate();
    return Array.from({ length: days }, (_, index) =>
        today.subtract({ days: days - index - 1 }).toString(),
    );
}

/** Start of the oldest day of the axis, in the requested zone. */
export function availabilityWindowStart(dayAxis: string[], tz: string): Date {
    const earliest = Temporal.PlainDate.from(dayAxis[0]).toZonedDateTime(tz);
    return new Date(earliest.epochMilliseconds);
}

/**
 * Reliable history start of a project: the later of its check watermark and the
 * retention edge. Mirrors `MonitoringDashboardService.coverage()`.
 */
export function reliableHistoryStart(checksStartedAt: Date, asOf: Date): Date {
    const cutoff = new Date(
        asOf.getTime() - AVAILABILITY_RETENTION_DAYS * DAY_MS,
    );
    return new Date(Math.max(checksStartedAt.getTime(), cutoff.getTime()));
}

/**
 * Project-level retention banner for an availability payload: `TRUNCATED` when
 * the requested window reaches before the reliable history start.
 */
export function availabilityHistory(params: {
    tz: string;
    from: Date;
    availableFrom: Date;
}) {
    return {
        retentionDays: AVAILABILITY_RETENTION_DAYS,
        availableFrom: iso(params.availableFrom, params.tz),
        status:
            params.from < params.availableFrom
                ? ('TRUNCATED' as const)
                : ('AVAILABLE' as const),
    };
}

const hourBuckets = (tz: string) => Prisma.sql`
        to_char("checkedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz},'YYYY-MM-DD') AS day,
        extract(hour FROM "checkedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::integer AS hour,
        COUNT(*)::integer AS checks, COUNT(*) FILTER (WHERE success)::integer AS successes`;

/**
 * Hourly LOCAL availability across a whole project, for the project monitoring
 * endpoints: rows are keyed by local date and hour only.
 */
export function projectHourlyRowsSql(params: {
    projectId: string;
    tz: string;
    from: Date;
    asOf: Date;
}): Prisma.Sql {
    return Prisma.sql`SELECT ${hourBuckets(params.tz)} FROM check_logs
        WHERE "projectId" = ${params.projectId} AND source = 'LOCAL' AND evaluated = true
        AND "checkedAt" >= ${params.from} AND "checkedAt" < ${params.asOf}
        GROUP BY day,hour`;
}

/**
 * Hourly LOCAL availability grouped per monitor, for a monitor set that may
 * span projects (public status pages). The caller passes the widest window
 * start it needs; per-monitor watermarks are applied cell by cell afterwards,
 * so this query stays a single aggregate.
 *
 * `monitorIds` must be non-empty: `IN ()` is not valid SQL.
 */
export function monitorHourlyRowsSql(params: {
    monitorIds: string[];
    tz: string;
    from: Date;
    asOf: Date;
}): Prisma.Sql {
    return Prisma.sql`SELECT "monitorId" AS "monitorId", ${hourBuckets(params.tz)} FROM check_logs
        WHERE "monitorId" IN (${Prisma.join(params.monitorIds)}) AND source = 'LOCAL' AND evaluated = true
        AND "checkedAt" >= ${params.from} AND "checkedAt" < ${params.asOf}
        GROUP BY "monitorId", day, hour`;
}

export const availabilityBucketKey = (day: string, hour: number) =>
    `${day}|${hour}`;

/** Buckets indexed by local date and hour, for O(1) cell lookups. */
export function indexHourlyRows<T extends HourlyAvailabilityRow>(
    rows: T[],
): Map<string, T> {
    return new Map(
        rows.map((row) => [availabilityBucketKey(row.day, row.hour), row]),
    );
}

export interface AvailabilityGrid {
    cells: number[][];
    unavailableCells: number[][];
    /** `[hour, dayIndex, value]` of the lowest cell, day then hour ascending. */
    worst: number[] | undefined;
}

/**
 * Turns aggregated rows into the public heatmap grid.
 *
 * An hour without samples produces no cell at all (never 0 or 100). An hour
 * whose whole interval is not covered by `availableFrom` is reported as
 * unavailable instead, so the client can tell "history is too short" from
 * "nothing was observed"; future and DST-skipped hours are in neither list.
 */
export function buildAvailabilityGrid(params: {
    days: string[];
    tz: string;
    asOf: Date;
    availableFrom: Date;
    lookup: (day: string, hour: number) => HourlyAvailabilityRow | undefined;
}): AvailabilityGrid {
    const { days, tz, asOf, availableFrom, lookup } = params;
    const cells: number[][] = [];
    const unavailableCells: number[][] = [];

    days.forEach((day, dayIndex) => {
        const intervals = localHourIntervals(day, tz, asOf);
        for (let hour = 0; hour < 24; hour += 1) {
            const selected = intervals.filter(
                (interval) => interval.hour === hour,
            );
            if (!selected.length) continue;
            if (selected.some((interval) => interval.from < availableFrom)) {
                unavailableCells.push([hour, dayIndex]);
                continue;
            }
            const row = lookup(day, hour);
            if (row) {
                cells.push([
                    hour,
                    dayIndex,
                    roundPercent((100 * row.successes) / row.checks),
                ]);
            }
        }
    });

    const worst = [...cells].sort(
        (a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0],
    )[0];

    return { cells, unavailableCells, worst };
}
