import {
    histogramKey,
    mergeHistograms,
    percentileFromHistogram,
    ratingFromValue,
} from './rum-perf-histogram';

describe('RUM performance histogram', () => {
    it('maps values onto their upper bound bucket', () => {
        expect(histogramKey('LCP', 90)).toBe('le_100');
        expect(histogramKey('LCP', 2500)).toBe('le_2500');
        expect(histogramKey('LCP', 50000)).toBe('gt_max');
        expect(histogramKey('CLS', 0.2)).toBe('le_0.25');
        expect(histogramKey('CLS', 42)).toBe('gt_max');
    });

    it('rebuilds an approximate percentile from merged buckets', () => {
        const histogram = {
            le_100: 10,
            le_200: 10,
            le_400: 60,
            le_800: 20,
        };

        expect(percentileFromHistogram('LCP', histogram, 0.5)).toBe(400);
        expect(percentileFromHistogram('LCP', histogram, 0.75)).toBe(400);
        expect(percentileFromHistogram('LCP', histogram, 0.95)).toBe(800);
        expect(percentileFromHistogram('LCP', {}, 0.75)).toBeNull();
        expect(percentileFromHistogram('LCP', null, 0.75)).toBeNull();
    });

    it('merges histograms by summing bucket counts', () => {
        const merged = mergeHistograms({ le_100: 1 }, { le_100: 2, le_200: 3 });
        expect(merged).toEqual({ le_100: 3, le_200: 3 });
    });

    it('derives a rating from the metric thresholds', () => {
        expect(ratingFromValue('LCP', 2000)).toBe('GOOD');
        expect(ratingFromValue('LCP', 3000)).toBe('NEEDS_IMPROVEMENT');
        expect(ratingFromValue('LCP', 5000)).toBe('POOR');
        expect(ratingFromValue('CLS', 0.05)).toBe('GOOD');
        expect(ratingFromValue('CLS', 0.3)).toBe('POOR');
    });
});
