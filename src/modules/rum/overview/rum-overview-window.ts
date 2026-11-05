import { BadRequestException } from '@nestjs/common';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DEFAULT_RANGE_MS = 24 * HOUR_MS;
const MAX_RANGE_MS = 90 * DAY_MS;

export interface OverviewWindow {
    from: Date;
    to: Date;
    rangeMs: number;
    bucketMinutes: number;
}

/**
 * 概览类接口共用的时间窗解析：默认最近 24 小时，最多 90 天，
 * 分桶大小缺省时按窗口长度推导，避免前端各自算一套。
 */
export function resolveOverviewWindow(
    from?: string,
    to?: string,
    bucketMinutes?: number,
): OverviewWindow {
    const end = to ? new Date(to) : new Date();
    const start = from
        ? new Date(from)
        : new Date(end.getTime() - DEFAULT_RANGE_MS);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new BadRequestException('from and to must be valid dates');
    }
    if (start > end) {
        throw new BadRequestException('from must not be after to');
    }
    const rangeMs = end.getTime() - start.getTime();
    if (rangeMs > MAX_RANGE_MS) {
        throw new BadRequestException('range must not exceed 90 days');
    }
    return {
        from: start,
        to: end,
        rangeMs,
        bucketMinutes: bucketMinutes ?? pickBucket(rangeMs),
    };
}

export function pickBucket(rangeMs: number): number {
    if (rangeMs <= HOUR_MS) return 5;
    if (rangeMs <= 6 * HOUR_MS) return 15;
    if (rangeMs <= DAY_MS) return 60;
    if (rangeMs <= 7 * DAY_MS) return 360;
    return 1440;
}

/** 百分比保留两位小数；分母为 0 时返回 null，不编造比率。 */
export function percentage(part: number, total: number): number | null {
    if (!total) return null;
    return Math.round((part / total) * 10_000) / 100;
}
