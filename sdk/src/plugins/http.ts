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

export function createHttpPlugin(
    options: RumHttpInstrumentationOptions = {},
): RumPlugin {
    const failureStatus = options.failureStatus ?? 400;
    const reportNetworkErrors = options.reportNetworkErrors ?? true;
    return {
        setup(context) {
            const restoreFetch = instrumentFetch(
                context,
                failureStatus,
                reportNetworkErrors,
                options.shouldReportError,
            );
            const restoreXhr = instrumentXhr(
                context,
                failureStatus,
                reportNetworkErrors,
                options.shouldReportError,
            );
            return () => {
                restoreFetch();
                restoreXhr();
            };
        },
    };
}

function instrumentFetch(
    context: RumPluginContext,
    failureStatus: number,
    reportNetworkErrors: boolean,
    shouldReport?: (http: RumHttpContext) => boolean,
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
                response.status >= failureStatus,
                shouldReport,
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
            if (reportNetworkErrors)
                reportHttpError(context, http, shouldReport);
            throw error;
        }
    };
    return () => {
        if (window.fetch !== original) window.fetch = original;
    };
}

function instrumentXhr(
    context: RumPluginContext,
    failureStatus: number,
    reportNetworkErrors: boolean,
    shouldReport?: (http: RumHttpContext) => boolean,
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
            if (this.status >= failureStatus) {
                reportHttpError(context, http, shouldReport);
            } else if (this.status === 0) {
                if (reportNetworkErrors)
                    reportHttpError(context, http, shouldReport);
            } else {
                recordHttp(context, http, false, shouldReport);
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
    shouldReport?: (http: RumHttpContext) => boolean,
): void {
    if (failed) {
        reportHttpError(context, http, shouldReport);
        return;
    }
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
    shouldReport?: (http: RumHttpContext) => boolean,
): void {
    if (shouldReport && !shouldReport(http)) {
        context.addBreadcrumb({
            type: 'http',
            category: 'ignored-failure',
            level: 'WARNING',
            data: http as Record<string, unknown>,
        });
        return;
    }
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
