import {
    availabilityDays,
    availabilityWindowStart,
    buildAvailabilityGrid,
    indexHourlyRows,
    reliableHistoryStart,
} from './availability.util';

describe('availabilityDays', () => {
    it('returns consecutive local days ending today, oldest first', () => {
        expect(
            availabilityDays(
                'Asia/Shanghai',
                new Date('2026-10-10T10:32:00Z'),
                3,
            ),
        ).toEqual(['2026-10-08', '2026-10-09', '2026-10-10']);
    });

    it('follows the requested zone across a UTC day boundary', () => {
        expect(
            availabilityDays(
                'America/New_York',
                new Date('2026-10-11T02:00:00Z'),
                3,
            ),
        ).toEqual(['2026-10-08', '2026-10-09', '2026-10-10']);
    });
});

describe('availabilityWindowStart', () => {
    it('returns the start of the oldest day in the requested zone', () => {
        expect(
            availabilityWindowStart(
                ['2026-03-03', '2026-03-04', '2026-03-05'],
                'UTC',
            ).toISOString(),
        ).toBe('2026-03-03T00:00:00.000Z');
    });
});

describe('reliableHistoryStart', () => {
    const asOf = new Date('2026-03-05T12:00:00.000Z');

    it('clamps a watermark older than the retention window', () => {
        expect(
            reliableHistoryStart(
                new Date('2025-01-01T00:00:00.000Z'),
                asOf,
            ).toISOString(),
        ).toBe('2025-12-05T12:00:00.000Z');
    });

    it('keeps a watermark newer than the retention window', () => {
        const started = new Date('2026-03-01T00:00:00.000Z');
        expect(reliableHistoryStart(started, asOf).toISOString()).toBe(
            '2026-03-01T00:00:00.000Z',
        );
    });
});

describe('indexHourlyRows', () => {
    it('keys rows by local date and hour', () => {
        const index = indexHourlyRows([
            { day: '2026-03-03', hour: 4, checks: 2, successes: 1 },
        ]);
        expect(index.get('2026-03-03|4')).toEqual({
            day: '2026-03-03',
            hour: 4,
            checks: 2,
            successes: 1,
        });
        expect(index.get('2026-03-03|5')).toBeUndefined();
    });
});

describe('buildAvailabilityGrid', () => {
    const everyHour = (day: string, hour: number) => ({
        day,
        hour,
        checks: 1,
        successes: 1,
    });

    it('emits no cell for an hour without samples', () => {
        const grid = buildAvailabilityGrid({
            days: ['2026-03-03', '2026-03-04'],
            tz: 'UTC',
            asOf: new Date('2026-03-05T00:00:00.000Z'),
            availableFrom: new Date('2020-01-01T00:00:00.000Z'),
            lookup: () => undefined,
        });

        expect(grid.cells).toEqual([]);
        expect(grid.unavailableCells).toEqual([]);
        expect(grid.worst).toBeUndefined();
    });

    it('keeps the lowest cell, day then hour ascending on ties', () => {
        const rows = new Map([
            [
                '2026-03-03|5',
                { day: '2026-03-03', hour: 5, checks: 2, successes: 1 },
            ],
            [
                '2026-03-04|1',
                { day: '2026-03-04', hour: 1, checks: 2, successes: 1 },
            ],
        ]);
        const grid = buildAvailabilityGrid({
            days: ['2026-03-03', '2026-03-04'],
            tz: 'UTC',
            asOf: new Date('2026-03-05T00:00:00.000Z'),
            availableFrom: new Date('2020-01-01T00:00:00.000Z'),
            lookup: (day, hour) => rows.get(`${day}|${hour}`),
        });

        expect(grid.cells).toEqual([
            [5, 0, 50],
            [1, 1, 50],
        ]);
        expect(grid.worst).toEqual([5, 0, 50]);
    });

    it('drops the local hour a spring-forward transition skips', () => {
        const tz = 'America/New_York';
        const asOf = new Date('2026-03-09T12:00:00.000Z');
        const grid = buildAvailabilityGrid({
            days: availabilityDays(tz, asOf, 3),
            tz,
            asOf,
            availableFrom: new Date('2020-01-01T00:00:00.000Z'),
            lookup: everyHour,
        });

        // 2026-03-08 loses 02:00-03:00 to daylight saving time.
        expect(grid.cells.filter((cell) => cell[1] === 1)).toHaveLength(23);
        expect(
            grid.cells.filter((cell) => cell[1] === 1 && cell[0] === 2),
        ).toEqual([]);
        expect(grid.unavailableCells.filter((cell) => cell[1] === 1)).toEqual(
            [],
        );
    });

    it('merges the two repeated local hours of a fall-back transition', () => {
        const tz = 'America/New_York';
        const asOf = new Date('2026-11-02T13:00:00.000Z');
        const grid = buildAvailabilityGrid({
            days: availabilityDays(tz, asOf, 3),
            tz,
            asOf,
            availableFrom: new Date('2020-01-01T00:00:00.000Z'),
            lookup: everyHour,
        });

        // 2026-11-01 has 01:00 twice: one cell, not two.
        expect(
            grid.cells.filter((cell) => cell[1] === 1 && cell[0] === 1),
        ).toHaveLength(1);
        expect(grid.cells.filter((cell) => cell[1] === 0)).toHaveLength(24);
    });

    it('reports a cell as unavailable when any part of it precedes the watermark', () => {
        const grid = buildAvailabilityGrid({
            days: ['2026-03-03', '2026-03-04'],
            tz: 'UTC',
            asOf: new Date('2026-03-05T00:00:00.000Z'),
            availableFrom: new Date('2026-03-04T10:00:00.000Z'),
            lookup: everyHour,
        });

        expect(grid.unavailableCells).toHaveLength(24 + 10);
        expect(grid.unavailableCells).toContainEqual([9, 1]);
        expect(grid.unavailableCells).not.toContainEqual([10, 1]);
        // 03-04 10:00 onwards is fully covered.
        expect(grid.cells.filter((cell) => cell[1] === 1)).toHaveLength(14);
    });

    it('keeps future hours of today out of the grid entirely', () => {
        const grid = buildAvailabilityGrid({
            days: ['2026-03-05'],
            tz: 'UTC',
            asOf: new Date('2026-03-05T12:00:00.000Z'),
            availableFrom: new Date('2020-01-01T00:00:00.000Z'),
            lookup: everyHour,
        });

        expect(grid.cells).toHaveLength(12);
        expect(grid.cells.at(-1)).toEqual([11, 0, 100]);
        expect(grid.unavailableCells).toEqual([]);
    });
});
