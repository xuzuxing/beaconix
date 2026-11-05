import { stripUrl } from '../sanitizer.js';
import type {
    RumHttpContext,
    RumHttpInstrumentationOptions,
    RumPlugin,
    RumPluginContext,
} from '../types.js';

interface XhrMetadata {
    method: string;
    url: string;
    startedAt: number;
}

interface HttpSettings {
    failureStatus: number;
    reportNetworkErrors: boolean;
    /** One `HTTP` performance sample per request, used for volume/rate/latency. */
    reportTimings: boolean;
    shouldReport?: (http: RumHttpContext) => boolean;
}

export function createHttpPlugin(
    options: RumHttpInstrumentationOptions = {},
): RumPlugin {
    const settings: HttpSettings = {
        failureStatus: options.failureStatus ?? 400,
        reportNetworkErrors: options.reportNetworkErrors ?? true,
        reportTimings: options.reportTimings ?? false,
        ...(options.shouldReportError
            ? { shouldReport: options.shouldReportError }
            : {}),
    };
    return {
        setup(context) {
            const restoreFetch = instrumentFetch(context, settings);
            const restoreXhr = instrumentXhr(context, settings);
            return () => {
                restoreFetch();
                restoreXhr();
            };
        },
    };
}

function instrumentFetch(
    context: RumPluginContext,
    settings: HttpSettings,
): () => void {
    if (typeof window.fetch !== 'function') return () => undefined;
    const original = window.fetch;
    window.fetch = async function (
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> {
        const method = resolveFetchMethod(input, init);
        const rawUrl = resolveFetchUrl(input);
        if (context.shouldIgnoreUrl(rawUrl)) {
            return original.call(this, input, init);
        }
        const startedAt = performance.now();
        try {
            const response = await original.call(this, input, init);
            const http = createHttpContext(
                method,
                rawUrl,
                response.status,
                startedAt,
                response.headers.get('x-request-id') ?? undefined,
            );
            recordHttp(
                context,
                http,
                response.status >= settings.failureStatus,
                settings,
            );
            return response;
        } catch (error) {
            const http = createHttpContext(
                method,
                rawUrl,
                0,
                startedAt,
                undefined,
                'network',
            );
            if (settings.reportNetworkErrors)
                reportHttpError(context, http, settings);
            throw error;
        }
    };
    return () => {
        if (window.fetch !== original) window.fetch = original;
    };
}

function instrumentXhr(
    context: RumPluginContext,
    settings: HttpSettings,
): () => void {
    if (typeof XMLHttpRequest === 'undefined') return () => undefined;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const metadata = new WeakMap<XMLHttpRequest, XhrMetadata>();

    XMLHttpRequest.prototype.open = function (
        method: string,
        url: string | URL,
        async: boolean = true,
        username?: string | null,
        password?: string | null,
    ) {
        metadata.set(this, {
            method: method.toUpperCase(),
            url: String(url),
            startedAt: 0,
        });
        return Reflect.apply(originalOpen, this, [
            method,
            String(url),
            async,
            username ?? null,
            password ?? null,
        ]);
    };
    XMLHttpRequest.prototype.send = function (
        body?: Document | XMLHttpRequestBodyInit | null,
    ) {
        const current = metadata.get(this);
        if (!current || context.shouldIgnoreUrl(current.url)) {
            return originalSend.call(this, body);
        }
        current.startedAt = performance.now();
        const onLoadEnd = () => {
            this.removeEventListener('loadend', onLoadEnd);
            const requestId = safeResponseHeader(this, 'x-request-id');
            const failureKind = this.status === 0 ? 'network' : undefined;
            const http = createHttpContext(
                current.method,
                current.url,
                this.status,
                current.startedAt,
                requestId,
                failureKind,
            );
            if (this.status >= settings.failureStatus) {
                reportHttpError(context, http, settings);
            } else if (this.status === 0) {
                if (settings.reportNetworkErrors)
                    reportHttpError(context, http, settings);
            } else {
                recordHttp(context, http, false, settings);
            }
        };
        this.addEventListener('loadend', onLoadEnd);
        return originalSend.call(this, body);
    };

    return () => {
        XMLHttpRequest.prototype.open = originalOpen;
        XMLHttpRequest.prototype.send = originalSend;
    };
}

function recordHttp(
    context: RumPluginContext,
    http: RumHttpContext,
    failed: boolean,
    settings: HttpSettings,
): void {
    if (failed) {
        reportHttpError(context, http, settings);
        return;
    }
    reportTiming(context, http, settings, true);
    context.addBreadcrumb({
        type: 'http',
        category: 'request',
        level: 'INFO',
        data: http as Record<string, unknown>,
    });
}

function reportHttpError(
    context: RumPluginContext,
    http: RumHttpContext,
    settings: HttpSettings,
): void {
    if (settings.shouldReport && !settings.shouldReport(http)) {
        context.addBreadcrumb({
            type: 'http',
            category: 'ignored-failure',
            level: 'WARNING',
            data: http as Record<string, unknown>,
        });
        return;
    }
    reportTiming(context, http, settings, false);
    const status = http.status ? ` ${http.status}` : '';
    void context.captureError(
        new Error(`HTTP${status} ${http.method ?? 'GET'} failed`),
        {
            type: 'http',
            category: 'HTTP',
            requestId: http.requestId,
            http,
        },
    );
}

/**
 * One sample per request keeps request volume, success rate and latency
 * measurable. Static assets stay on the web-vitals path so the two plugins
 * never report the same entry twice.
 */
function reportTiming(
    context: RumPluginContext,
    http: RumHttpContext,
    settings: HttpSettings,
    success: boolean,
): void {
    if (!settings.reportTimings) return;
    void context.reportPerformance([
        {
            metric: 'HTTP',
            value: Math.max(0, Math.round(http.durationMs ?? 0)),
            ...(http.url ? { dimension: http.url.slice(0, 500) } : {}),
            success,
            occurredAt: new Date().toISOString(),
        },
    ]);
}

function createHttpContext(
    method: string,
    url: string,
    status: number,
    startedAt: number,
    requestId?: string,
    failureKind?: string,
): RumHttpContext {
    return {
        method: method.toUpperCase().slice(0, 20),
        url: stripUrl(url),
        status,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        ...(requestId ? { requestId: requestId.slice(0, 200) } : {}),
        ...(failureKind ? { failureKind } : {}),
    };
}

function resolveFetchMethod(
    input: RequestInfo | URL,
    init?: RequestInit,
): string {
    if (init?.method) return init.method.toUpperCase();
    if (typeof Request !== 'undefined' && input instanceof Request) {
        return input.method.toUpperCase();
    }
    return 'GET';
}

function resolveFetchUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
    return (input as Request).url;
}

function safeResponseHeader(
    xhr: XMLHttpRequest,
    name: string,
): string | undefined {
    try {
        return xhr.getResponseHeader(name) ?? undefined;
    } catch {
        return undefined;
    }
}
