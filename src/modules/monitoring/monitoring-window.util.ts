import { Temporal } from '@js-temporal/polyfill';

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export type MonitoringRange = '1h' | 'today' | '7d' | '30d';
export type HistoryStatus = 'AVAILABLE' | 'EMPTY' | 'TRUNCATED' | 'UNAVAILABLE';
export const zoned = (at: Date, tz: string) =>
    Temporal.Instant.fromEpochMilliseconds(at.getTime()).toZonedDateTimeISO(tz);
export const iso = (at: Date, tz: string) =>
    zoned(at, tz).toString({
        timeZoneName: 'never',
        calendarName: 'never',
        fractionalSecondDigits: 3,
    });
export const dateFrom = (at: { epochMilliseconds: number }) =>
    new Date(at.epochMilliseconds);

export function startOfDate(tz: string, date: string): Date | null {
    const day = Temporal.PlainDate.from(date);
    const start = day.toZonedDateTime(tz).startOfDay();
    return start.toPlainDate().equals(day) ? dateFrom(start) : null;
}

export function monitoringWindow(
    asOf: Date,
    range: MonitoringRange,
    tz: string,
) {
    let from: Date;
    let previousFrom: Date | null;
    let previousTo: Date | null;
    const span =
        range === '1h' ? HOUR_MS : range === '7d' ? 7 * DAY_MS : 30 * DAY_MS;
    if (range === 'today') {
        const now = zoned(asOf, tz);
        from = dateFrom(now.startOfDay());
        const yesterday = now.toPlainDate().subtract({ days: 1 });
        previousFrom = startOfDate(tz, yesterday.toString());
        const previousEnd = yesterday
            .toPlainDateTime(now.toPlainTime())
            .toZonedDateTime(tz, { disambiguation: 'compatible' });
        previousTo = previousEnd.toPlainDate().equals(yesterday)
            ? dateFrom(previousEnd)
            : null;
        if (!previousFrom || !previousTo) previousFrom = previousTo = null;
    } else {
        from = new Date(asOf.getTime() - span);
        previousTo = from;
        previousFrom = new Date(from.getTime() - span);
    }
    const step =
        range === '1h'
            ? 120_000
            : range === '7d'
              ? 6 * HOUR_MS
              : range === '30d'
                ? DAY_MS
                : HOUR_MS;
    const first =
        range === 'today'
            ? from.getTime()
            : Math.floor(from.getTime() / step) * step;
    const buckets: {
        start: Date;
        from: Date;
        to: Date;
        durationSeconds: number;
    }[] = [];
    for (let time = first; time < asOf.getTime(); time += step) {
        const begin = Math.max(time, from.getTime());
        const end = Math.min(time + step, asOf.getTime());
        buckets.push({
            start: new Date(time),
            from: new Date(begin),
            to: new Date(end),
            durationSeconds: (end - begin) / 1000,
        });
    }
    return {
        from,
        to: asOf,
        previousFrom,
        previousTo,
        step,
        first,
        interval:
            range === '1h'
                ? '2m'
                : range === '7d'
                  ? '6h'
                  : range === '30d'
                    ? '24h'
                    : '1h',
        buckets,
    };
}

export function localHourIntervals(date: string, tz: string, asOf: Date) {
    const day = Temporal.PlainDate.from(date);
    const start = startOfDate(tz, date);
    if (!start) return [];
    const end = Math.min(
        day.add({ days: 1 }).toZonedDateTime(tz).epochMilliseconds,
        asOf.getTime(),
    );
    const result: { hour: number; from: Date; to: Date }[] = [];
    let cursor = start.getTime();
    while (cursor < end) {
        const local = zoned(new Date(cursor), tz);
        const nextHour = local
            .with({ minute: 0, second: 0, millisecond: 0 })
            .add({ hours: 1 }).epochMilliseconds;
        const transition =
            local.getTimeZoneTransition('next')?.epochMilliseconds ?? Infinity;
        const next = Math.min(
            end,
            nextHour > cursor ? nextHour : cursor + HOUR_MS,
            transition,
        );
        result.push({
            hour: local.hour,
            from: new Date(cursor),
            to: new Date(next),
        });
        cursor = next;
    }
    return result;
}

export const roundPercent = (value: number) => Math.round(value * 100) / 100;
export const coverageStatus = (
    from: Date | null,
    available: Date,
    samples: number,
): HistoryStatus =>
    !from
        ? 'UNAVAILABLE'
        : from < available
          ? 'TRUNCATED'
          : samples
            ? 'AVAILABLE'
            : 'EMPTY';
