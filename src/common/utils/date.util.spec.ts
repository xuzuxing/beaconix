import dayjs from 'dayjs';
import { toIsoString } from './date.util';
import type { DateInput } from './date.util';

describe('toIsoString', () => {
    const iso = '2026-10-10T13:30:49.009Z';

    it.each([
        new Date(iso),
        iso,
        Date.parse(iso),
        dayjs(iso),
        '2026-10-10T21:30:49.009+08:00',
    ])('preserves the instant and milliseconds for %s', (value) => {
        expect(toIsoString(value)).toBe(iso);
    });

    it('supports the Unix epoch without treating zero as missing', () => {
        expect(toIsoString(0)).toBe('1970-01-01T00:00:00.000Z');
    });

    it('preserves UTC parsing for date-only strings', () => {
        expect(toIsoString('2026-10-10')).toBe('2026-10-10T00:00:00.000Z');
    });

    it('preserves native parsing for dates without a timezone', () => {
        const input = '2026-10-10T13:30:49.009';
        expect(toIsoString(input)).toBe(new Date(input).toISOString());
    });

    it('does not mutate the input date', () => {
        const date = new Date(iso);
        const timestamp = date.getTime();
        toIsoString(date);
        expect(date.getTime()).toBe(timestamp);
    });

    it('formats the current timestamp under the test clock', () => {
        jest.useFakeTimers().setSystemTime(new Date(iso));
        try {
            expect(toIsoString(Date.now())).toBe(iso);
        } finally {
            jest.useRealTimers();
        }
    });

    it.each(['', 'not-a-date', new Date(NaN), NaN, Infinity, null, undefined])(
        'rejects invalid or missing dates: %s',
        (value) => {
            expect(() => toIsoString(value as DateInput)).toThrow(RangeError);
        },
    );
});
