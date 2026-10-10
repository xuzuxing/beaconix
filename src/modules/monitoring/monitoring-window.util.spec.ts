import {
    DAY_MS,
    iso,
    localHourIntervals,
    monitoringWindow,
    startOfDate,
} from './monitoring-window.util';

describe('Monitoring time windows', () => {
    it.each([
        ['1h', 31],
        ['7d', 29],
        ['30d', 31],
    ] as const)('bounds %s UTC buckets', (range, max) => {
        const w = monitoringWindow(
            new Date('2026-10-10T10:32:35.000Z'),
            range,
            'Asia/Kolkata',
        );
        expect(w.buckets.length).toBeLessThanOrEqual(max);
        expect(w.buckets.every((b) => b.durationSeconds > 0)).toBe(true);
        expect(w.previousTo).toEqual(w.from);
    });
    it('handles missing and repeated midnight', () => {
        expect(
            iso(
                startOfDate('America/Santiago', '2026-09-06')!,
                'America/Santiago',
            ),
        ).toContain('T01:00:00');
        expect(
            iso(startOfDate('America/Havana', '2026-11-01')!, 'America/Havana'),
        ).toContain('-04:00');
        expect(startOfDate('Pacific/Apia', '2011-12-30')).toBeNull();
    });
    it('merges repeated hours but preserves their actual intervals', () => {
        const intervals = localHourIntervals(
            '2026-11-01',
            'America/New_York',
            new Date('2026-11-02T12:00:00Z'),
        );
        expect(intervals.filter((i) => i.hour === 1)).toHaveLength(2);
        expect(
            intervals.reduce(
                (n, i) => n + i.to.getTime() - i.from.getTime(),
                0,
            ),
        ).toBe(25 * 3600000);
    });
    it('uses calendar comparison and permits 720.5h for thirty local dates', () => {
        const now = new Date('2026-11-02T23:30:00-05:00');
        const from = startOfDate('America/New_York', '2026-10-04')!;
        expect((now.getTime() - from.getTime()) / 3600000).toBe(720.5);
        const w = monitoringWindow(now, 'today', 'America/New_York');
        expect(now.getTime() - w.from.getTime()).toBe(23.5 * 3600000);
        expect(w.previousTo!.getTime() - w.previousFrom!.getTime()).toBe(
            24.5 * 3600000,
        );
        expect(now.getTime() - 30 * DAY_MS).toBeLessThan(now.getTime());
    });
});
