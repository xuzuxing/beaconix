import dayjs from 'dayjs';

export type DateInput = Date | string | number | dayjs.Dayjs;

/** UTC ISO timestamp with milliseconds, including dates restored from JSON. */
export function toIsoString(value: DateInput): string {
    if (value === null || value === undefined) {
        throw new RangeError('Invalid time value');
    }

    // Preserve native parsing semantics, especially UTC date-only strings.
    const date = dayjs(typeof value === 'string' ? new Date(value) : value);
    if (!date.isValid()) {
        throw new RangeError('Invalid time value');
    }
    return date.toISOString();
}
