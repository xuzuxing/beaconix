import {
    RUM_PERF_METRICS,
    RUM_PERF_RATINGS,
    type RumPerfMetricValue,
    type RumPerfRatingValue,
} from '../dto/rum-performance.dto';

const CLS_BOUNDS = [0.1, 0.25, 0.5, 1, 2, 4, 10];
const MS_BOUNDS = [
    50, 100, 200, 400, 800, 1200, 1800, 2500, 4000, 6000, 10000, 20000, 40000,
];

export function perfBounds(metric: RumPerfMetricValue): number[] {
    return metric === 'CLS' ? CLS_BOUNDS : MS_BOUNDS;
}

/**
 * Maps a raw value onto its histogram bucket. Buckets store an upper bound so
 * an approximate percentile can be rebuilt from merged hour buckets without
 * keeping the raw samples forever.
 */
export function histogramKey(
    metric: RumPerfMetricValue,
    value: number,
): string {
    for (const bound of perfBounds(metric)) {
        if (value <= bound) return `le_${bound}`;
    }
    return 'gt_max';
}

export function percentileFromHistogram(
    metric: RumPerfMetricValue,
    histogram: Record<string, unknown> | null | undefined,
    percentile: number,
): number | null {
    if (!histogram) return null;
    const bounds = perfBounds(metric);
    const counts = bounds.map((bound) => Number(histogram[`le_${bound}`] ?? 0));
    const overflow = Number(histogram['gt_max'] ?? 0);
    const total = counts.reduce((sum, count) => sum + count, 0) + overflow;
    if (!total) return null;
    const target = total * percentile;
    let cumulative = 0;
    for (let index = 0; index < bounds.length; index += 1) {
        cumulative += counts[index];
        if (cumulative >= target) return bounds[index];
    }
    return bounds[bounds.length - 1];
}

export function mergeHistograms(
    target: Record<string, number>,
    source: Record<string, unknown> | null | undefined,
): Record<string, number> {
    if (!source) return target;
    for (const [key, value] of Object.entries(source)) {
        target[key] = (target[key] ?? 0) + Number(value ?? 0);
    }
    return target;
}

export function hourBucket(value: Date): Date {
    const bucket = new Date(value);
    bucket.setUTCMinutes(0, 0, 0);
    return bucket;
}

export function ratingFromValue(
    metric: RumPerfMetricValue,
    value: number,
): RumPerfRatingValue {
    const thresholds = RATING_THRESHOLDS[metric];
    if (value <= thresholds.good) return 'GOOD';
    if (value <= thresholds.poor) return 'NEEDS_IMPROVEMENT';
    return 'POOR';
}

const RATING_THRESHOLDS: Record<
    RumPerfMetricValue,
    { good: number; poor: number }
> = {
    LCP: { good: 2500, poor: 4000 },
    INP: { good: 200, poor: 500 },
    CLS: { good: 0.1, poor: 0.25 },
    FCP: { good: 1800, poor: 3000 },
    TTFB: { good: 800, poor: 1800 },
    PAGE_LOAD: { good: 2500, poor: 4000 },
    RESOURCE: { good: 1000, poor: 3000 },
    HTTP: { good: 800, poor: 2000 },
};

export const RUM_PERF_METRIC_LIST = RUM_PERF_METRICS;
export const RUM_PERF_RATING_LIST = RUM_PERF_RATINGS;
