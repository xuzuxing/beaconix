export type RumErrorCategory =
    'JAVASCRIPT' | 'PROMISE' | 'RESOURCE' | 'HTTP' | 'VUE' | 'MANUAL';

export type RumErrorLevel = 'INFO' | 'WARNING' | 'ERROR' | 'FATAL';

export interface RumBreadcrumb {
    type: string;
    category?: string;
    level?: RumErrorLevel;
    occurredAt: string;
    data?: Record<string, unknown>;
}

export interface RumHttpContext {
    method?: string;
    url?: string;
    status?: number;
    durationMs?: number;
    requestId?: string;
    failureKind?: string;
}

export interface RumResourceContext {
    tagName?: string;
    url?: string;
}

export interface RumVueContext {
    componentName?: string;
    info?: string;
}

export interface RumSessionReplayOptions {
    enabled: boolean;
    /** Masks every text node in DOM snapshots and mutations. Default: true. */
    maskText?: boolean;
    flushIntervalMs?: number;
    maxBatchEvents?: number;
    /** Conservative client-side chunk limit. Default: 48 KiB. */
    maxPayloadBytes?: number;
}

export interface RumHttpInstrumentationOptions {
    enabled?: boolean;
    failureStatus?: number;
    reportNetworkErrors?: boolean;
    /**
     * Report one HTTP performance sample per instrumented request so the console
     * can chart request volume, success rate and latency. Defaults to
     * `performance.enabled`, because timings are sampled telemetry.
     */
    reportTimings?: boolean;
    /**
     * Return false to suppress a failed request, for example an intermediate
     * 401 that the host application's token-refresh flow will retry.
     */
    shouldReportError?: (context: RumHttpContext) => boolean;
}

export type RumPerfMetric =
    'LCP' | 'CLS' | 'INP' | 'FCP' | 'TTFB' | 'PAGE_LOAD' | 'RESOURCE' | 'HTTP';

export interface RumPerfSample {
    metric: RumPerfMetric;
    value: number;
    page?: string;
    release?: string;
    dimension?: string;
    success?: boolean;
    occurredAt?: string;
}

export interface RumPerformanceOptions {
    enabled?: boolean;
    /** Report resource and fetch/XHR timings slower than the threshold. */
    reportResources?: boolean;
    resourceThresholdMs?: number;
    flushIntervalMs?: number;
    /** Fraction of page loads that collect performance data. Default: 1. */
    sampleRate?: number;
}

export interface RumCollectionOptions {
    errors?: boolean;
    rejections?: boolean;
    resources?: boolean;
    routes?: boolean;
    console?: boolean;
    clicks?: boolean;
    /** Report `$pageview` on load and after every SPA navigation. */
    pageviews?: boolean;
}

export interface RumBrowserOptions {
    endpoint: string;
    publicKey: string;
    release?: string;
    userId?: string;
    anonymousId?: string;
    sessionId?: string;
    sampleRate?: number;
    dedupeWindowMs?: number;
    maxBreadcrumbs?: number;
    collection?: RumCollectionOptions;
    http?: boolean | RumHttpInstrumentationOptions;
    ignoreUrls?: Array<string | RegExp>;
    sessionReplay?: boolean | RumSessionReplayOptions;
    performance?: boolean | RumPerformanceOptions;
}

export interface RumErrorPayload {
    schemaVersion: 2;
    clientEventId: string;
    category: RumErrorCategory;
    level: RumErrorLevel;
    type: string;
    message: string;
    stack?: string;
    page?: string;
    release?: string;
    sessionId?: string;
    userId?: string;
    anonymousId?: string;
    requestId?: string;
    http?: RumHttpContext;
    resource?: RumResourceContext;
    vue?: RumVueContext;
    breadcrumbs: RumBreadcrumb[];
    sdk: { name: '@beaconix/rum-browser'; version: string };
    occurredAt: string;
}

export interface RumCaptureErrorOptions {
    type?: string;
    category?: RumErrorCategory;
    level?: RumErrorLevel;
    requestId?: string;
    http?: RumHttpContext;
    resource?: RumResourceContext;
    vue?: RumVueContext;
}

export interface RumVueAppLike {
    config: {
        errorHandler?: (error: unknown, instance: any, info: string) => void;
    };
}

export interface RumPluginContext {
    addBreadcrumb(breadcrumb: Omit<RumBreadcrumb, 'occurredAt'>): void;
    captureError(
        error: unknown,
        options?: RumCaptureErrorOptions,
    ): Promise<void>;
    captureEvent(
        eventName: string,
        properties?: Record<string, unknown>,
    ): Promise<void>;
    currentPage(): string;
    shouldIgnoreUrl(url: string): boolean;
    reportPerformance(samples: RumPerfSample[]): Promise<void>;
}

export interface RumPlugin {
    setup(context: RumPluginContext): () => void;
}
