import { stripUrl } from '../sanitizer.js';
import type {
    RumPerfSample,
    RumPerformanceOptions,
    RumPlugin,
} from '../types.js';

const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_RESOURCE_THRESHOLD_MS = 1_000;
const MAX_BUFFER = 50;

/**
 * Collects Web Vitals through PerformanceObserver and reports them in batches.
 * Everything is best effort: missing entry types (older browsers) simply skip
 * that metric, and collection never throws into the host application.
 */
export function createWebVitalsPlugin(
    rawOptions: RumPerformanceOptions = {},
): RumPlugin {
    const flushIntervalMs =
        rawOptions.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    const resourceThresholdMs =
        rawOptions.resourceThresholdMs ?? DEFAULT_RESOURCE_THRESHOLD_MS;
    const reportResources = rawOptions.reportResources ?? true;
    const sampleRate = rawOptions.sampleRate ?? 1;

    return {
        setup(context) {
            if (
                typeof window === 'undefined' ||
                typeof PerformanceObserver === 'undefined'
            ) {
                return () => {};
            }
            if (Math.random() > sampleRate) return () => {};

            const buffer: RumPerfSample[] = [];
            const observers: PerformanceObserver[] = [];
            let timer: ReturnType<typeof setInterval> | undefined;
            let finalized = false;

            const push = (sample: RumPerfSample) => {
                buffer.push({ ...sample, page: context.currentPage() });
                if (buffer.length >= MAX_BUFFER) flush();
            };

            const flush = () => {
                if (!buffer.length) return;
                const samples = buffer.splice(0, buffer.length);
                void context.reportPerformance(samples);
            };

            const observe = (
                type: string,
                handler: (entries: PerformanceEntry[]) => void,
            ) => {
                try {
                    const observer = new PerformanceObserver((list) =>
                        handler(list.getEntries()),
                    );
                    observer.observe({
                        type,
                        buffered: true,
                    } as PerformanceObserverInit);
                    observers.push(observer);
                } catch {
                    // The entry type is not supported by this browser.
                }
            };

            const occurredAt = () => new Date().toISOString();
            let lcp = 0;
            let cls = 0;
            let inp = 0;

            observe('largest-contentful-paint', (entries) => {
                const last = entries[entries.length - 1];
                if (last) lcp = last.startTime;
            });
            observe('layout-shift', (entries) => {
                for (const entry of entries as Array<
                    PerformanceEntry & {
                        value: number;
                        hadRecentInput: boolean;
                    }
                >) {
                    if (!entry.hadRecentInput) cls += entry.value;
                }
            });
            observe('event', (entries) => {
                for (const entry of entries) {
                    if (entry.duration > inp) inp = entry.duration;
                }
            });
            observe('paint', (entries) => {
                const fcp = entries.find(
                    (entry) => entry.name === 'first-contentful-paint',
                );
                if (fcp)
                    push({
                        metric: 'FCP',
                        value: Math.round(fcp.startTime),
                        occurredAt: occurredAt(),
                    });
            });
            if (reportResources) {
                observe('resource', (entries) => {
                    for (const entry of entries) {
                        const resource = entry as PerformanceResourceTiming;
                        const duration = resource.duration;
                        if (!duration || duration < resourceThresholdMs)
                            continue;
                        // fetch/XHR are reported by the http plugin (one sample
                        // per request, success included). Skipping them here
                        // keeps the threshold from hiding fast requests.
                        if (
                            resource.initiatorType === 'fetch' ||
                            resource.initiatorType === 'xmlhttprequest'
                        )
                            continue;
                        const responseStatus = (
                            resource as PerformanceResourceTiming & {
                                responseStatus?: number;
                            }
                        ).responseStatus;
                        const success =
                            typeof responseStatus === 'number'
                                ? responseStatus < 400
                                : (resource.transferSize ?? 0) > 0;
                        push({
                            metric: 'RESOURCE',
                            value: Math.round(duration),
                            dimension: stripUrl(resource.name).slice(0, 500),
                            success,
                            occurredAt: occurredAt(),
                        });
                    }
                });
            }

            const reportFinal = () => {
                if (finalized) return;
                finalized = true;
                if (lcp)
                    push({
                        metric: 'LCP',
                        value: Math.round(lcp),
                        occurredAt: occurredAt(),
                    });
                if (cls)
                    push({
                        metric: 'CLS',
                        value: Math.round(cls * 1000) / 1000,
                        occurredAt: occurredAt(),
                    });
                const navigation = performance.getEntriesByType(
                    'navigation',
                )[0] as PerformanceNavigationTiming | undefined;
                if (navigation) {
                    push({
                        metric: 'TTFB',
                        value: Math.round(navigation.responseStart),
                        occurredAt: occurredAt(),
                    });
                    if (navigation.loadEventEnd) {
                        push({
                            metric: 'PAGE_LOAD',
                            value: Math.round(navigation.loadEventEnd),
                            occurredAt: occurredAt(),
                        });
                    }
                }
                // INP is only meaningful once interaction happened.
                if (inp)
                    push({
                        metric: 'INP',
                        value: Math.round(inp),
                        occurredAt: occurredAt(),
                    });
                flush();
            };

            const onVisibility = () => {
                if (
                    typeof document !== 'undefined' &&
                    document.visibilityState === 'hidden'
                ) {
                    reportFinal();
                }
            };
            if (typeof document !== 'undefined') {
                document.addEventListener('visibilitychange', onVisibility);
            }
            window.addEventListener('pagehide', reportFinal);
            timer = setInterval(flush, flushIntervalMs);

            return () => {
                if (timer) clearInterval(timer);
                if (typeof document !== 'undefined') {
                    document.removeEventListener(
                        'visibilitychange',
                        onVisibility,
                    );
                }
                window.removeEventListener('pagehide', reportFinal);
                for (const observer of observers) observer.disconnect();
                reportFinal();
            };
        },
    };
}
