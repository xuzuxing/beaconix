import { BreadcrumbBuffer } from './breadcrumbs.js';
import { createClickPlugin } from './plugins/click.js';
import { createConsolePlugin } from './plugins/console.js';
import { createErrorPlugin } from './plugins/error.js';
import { createHttpPlugin } from './plugins/http.js';
import { createRejectionPlugin } from './plugins/rejection.js';
import { createResourcePlugin } from './plugins/resource.js';
import { createRoutePlugin } from './plugins/route.js';
import { installVueErrorHandler } from './plugins/vue.js';
import { createWebVitalsPlugin } from './plugins/web-vitals.js';
import { RumReplayRecorder } from './replay.js';
import { sanitizeText, stripUrl } from './sanitizer.js';
import { FetchRumTransport } from './transport.js';
import type {
    RumBreadcrumb,
    RumBrowserOptions,
    RumCaptureErrorOptions,
    RumErrorCategory,
    RumErrorPayload,
    RumHttpContext,
    RumPerfSample,
    RumPerformanceOptions,
    RumPlugin,
    RumPluginContext,
    RumSessionReplayOptions,
    RumVueAppLike,
    RumVueContext,
} from './types.js';

const SDK_VERSION = '0.3.0';
export const DEFAULT_DEDUPE_WINDOW_MS = 1_000;
const MAX_RECENT_ERRORS = 500;

export class RumBrowserClient {
    private readonly transport: FetchRumTransport;
    private readonly release?: string;
    private readonly userId?: string;
    private readonly anonymousId?: string;
    private readonly sessionId: string;
    private readonly sampleRate: number;
    private readonly dedupeWindowMs: number;
    private readonly breadcrumbs: BreadcrumbBuffer;
    private readonly recentlySent = new Map<string, number>();
    private readonly plugins: RumPlugin[];
    private readonly ignoreUrls: Array<string | RegExp>;
    private readonly replay: RumReplayRecorder | null;
    private cleanups: Array<() => void> = [];
    private initialized = false;

    constructor(options: RumBrowserOptions) {
        if (!options.endpoint) throw new Error('RUM endpoint is required');
        if (!options.publicKey) throw new Error('RUM publicKey is required');
        const sampleRate = options.sampleRate ?? 1;
        if (sampleRate < 0 || sampleRate > 1) {
            throw new Error('RUM sampleRate must be between 0 and 1');
        }
        this.transport = new FetchRumTransport(
            options.endpoint,
            options.publicKey,
        );
        this.release = cleanOptional(options.release, 100);
        this.userId = cleanOptional(options.userId, 200);
        this.anonymousId = cleanOptional(options.anonymousId, 200);
        this.sessionId = options.sessionId || createEventId('session');
        if (!/^[A-Za-z0-9_-]{8,100}$/.test(this.sessionId)) {
            throw new Error('RUM sessionId must be 8-100 URL-safe characters');
        }
        this.sampleRate = sampleRate;
        this.dedupeWindowMs =
            options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
        if (!Number.isFinite(this.dedupeWindowMs) || this.dedupeWindowMs < 0) {
            throw new Error('RUM dedupeWindowMs must be zero or greater');
        }
        this.breadcrumbs = new BreadcrumbBuffer(options.maxBreadcrumbs ?? 50);
        this.ignoreUrls = [
            this.transport.endpoint,
            /\/api\/rum(?:\/|$)/i,
            ...(options.ignoreUrls ?? []),
        ];
        this.plugins = this.createPlugins(options);
        const replayOptions = normalizeReplayOptions(options.sessionReplay);
        this.replay = replayOptions.enabled
            ? new RumReplayRecorder(
                  replayOptions,
                  this.transport,
                  this.sessionId,
                  this.release,
                  () => this.currentPage(),
              )
            : null;
    }

    init(): () => void {
        if (this.initialized) return () => this.destroy();
        if (typeof window === 'undefined') {
            throw new Error('RUM browser SDK requires a browser environment');
        }
        this.initialized = true;
        const context = this.pluginContext();
        this.cleanups = this.plugins.map((plugin) => plugin.setup(context));
        this.replay?.start();
        return () => this.destroy();
    }

    destroy(): void {
        if (!this.initialized) return;
        for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
        this.replay?.stop();
        this.initialized = false;
    }

    getSessionId(): string {
        return this.sessionId;
    }

    addBreadcrumb(breadcrumb: Omit<RumBreadcrumb, 'occurredAt'>): void {
        this.breadcrumbs.add(breadcrumb);
    }

    installVue(app: RumVueAppLike): () => void {
        return installVueErrorHandler(app, this.pluginContext());
    }

    async captureError(
        value: unknown,
        options: RumCaptureErrorOptions = {},
    ): Promise<void> {
        if (Math.random() > this.sampleRate) return;
        const error = normalizeError(value);
        const category = options.category ?? 'MANUAL';
        const type = sanitizeText(options.type ?? error.name ?? 'Error', 100);
        const message = sanitizeText(error.message || String(value), 2000);
        const stack = error.stack
            ? sanitizeText(error.stack, 16_000)
            : undefined;
        const fingerprint = createDedupeKey(category, type, message, options);
        const now = Date.now();
        const lastSent = this.recentlySent.get(fingerprint);
        if (lastSent && now - lastSent < this.dedupeWindowMs) return;
        this.recentlySent.set(fingerprint, now);
        this.pruneRecentErrors(now);

        const payload: RumErrorPayload = {
            schemaVersion: 2,
            clientEventId: createEventId('event'),
            category,
            level: options.level ?? 'ERROR',
            type,
            message,
            ...(stack ? { stack } : {}),
            page: this.currentPage(),
            ...(this.release ? { release: this.release } : {}),
            sessionId: this.sessionId,
            ...(this.userId ? { userId: this.userId } : {}),
            ...(this.anonymousId ? { anonymousId: this.anonymousId } : {}),
            ...(options.requestId ? { requestId: options.requestId } : {}),
            ...(options.http ? { http: options.http } : {}),
            ...(options.resource ? { resource: options.resource } : {}),
            ...(options.vue ? { vue: options.vue } : {}),
            breadcrumbs: this.breadcrumbs.snapshot(),
            sdk: { name: '@beaconix/rum-browser', version: SDK_VERSION },
            occurredAt: new Date(now).toISOString(),
        };
        const sent = await this.transport.send(
            'errors',
            payload as unknown as Record<string, unknown>,
        );
        if (sent) {
            this.addBreadcrumb({
                type: 'error',
                category: category.toLowerCase(),
                level: payload.level,
                data: { type, message },
            });
        }
    }

    captureMessage(
        message: string,
        options: Omit<RumCaptureErrorOptions, 'type'> & { type?: string } = {},
    ): Promise<void> {
        return this.captureError(new Error(message), {
            ...options,
            type: options.type ?? 'Message',
            category: options.category ?? 'MANUAL',
        });
    }

    captureHttpError(http: RumHttpContext): Promise<void> {
        const status = http.status ? ` ${http.status}` : '';
        return this.captureError(
            new Error(`HTTP${status} ${http.method ?? 'GET'} failed`),
            {
                type: 'http',
                category: 'HTTP',
                requestId: http.requestId,
                http,
            },
        );
    }

    captureVueError(error: unknown, vue: RumVueContext): Promise<void> {
        return this.captureError(error, {
            type: error instanceof Error ? error.name : 'VueError',
            category: 'VUE',
            vue,
        });
    }

    async captureEvent(
        eventName: string,
        properties: Record<string, unknown> = {},
    ): Promise<void> {
        if (!/^[A-Za-z0-9._:-]{1,100}$/.test(eventName)) {
            throw new Error('Invalid RUM event name');
        }
        await this.transport.send('events', {
            eventName,
            userId: this.userId,
            anonymousId: this.anonymousId,
            sessionId: this.sessionId,
            release: this.release,
            page: this.currentPage(),
            properties,
            occurredAt: new Date().toISOString(),
        });
    }

    flushReplay(): Promise<void> {
        return this.replay?.flush() ?? Promise.resolve();
    }

    async reportPerformance(samples: RumPerfSample[]): Promise<void> {
        if (!samples.length) return;
        await this.transport.send('performance', {
            schemaVersion: 1,
            samples: samples.map((sample) => ({
                ...sample,
                page: sample.page ?? this.currentPage(),
                ...(this.release ? { release: this.release } : {}),
                ...(this.userId ? { endUserId: this.userId } : {}),
            })),
            sessionId: this.sessionId,
        });
    }

    private createPlugins(options: RumBrowserOptions): RumPlugin[] {
        const collection = {
            errors: true,
            rejections: true,
            resources: true,
            routes: true,
            console: true,
            clicks: true,
            ...options.collection,
        };
        const plugins: RumPlugin[] = [];
        if (collection.errors) plugins.push(createErrorPlugin());
        if (collection.rejections) plugins.push(createRejectionPlugin());
        if (collection.resources) plugins.push(createResourcePlugin());
        if (collection.routes) plugins.push(createRoutePlugin());
        if (collection.console) plugins.push(createConsolePlugin());
        if (collection.clicks) plugins.push(createClickPlugin());
        if (options.http !== false) {
            const httpOptions =
                typeof options.http === 'object' ? options.http : {};
            if (httpOptions.enabled !== false) {
                plugins.push(createHttpPlugin(httpOptions));
            }
        }
        const performanceOptions = normalizePerformanceOptions(
            options.performance,
        );
        if (performanceOptions.enabled) {
            plugins.push(createWebVitalsPlugin(performanceOptions));
        }
        return plugins;
    }

    private pluginContext(): RumPluginContext {
        return {
            addBreadcrumb: (breadcrumb) => this.addBreadcrumb(breadcrumb),
            captureError: (error, options) => this.captureError(error, options),
            currentPage: () => this.currentPage(),
            shouldIgnoreUrl: (url) => this.shouldIgnoreUrl(url),
            reportPerformance: (samples) => this.reportPerformance(samples),
        };
    }

    private currentPage(): string {
        return typeof window === 'undefined'
            ? ''
            : stripUrl(window.location.href);
    }

    private shouldIgnoreUrl(value: string): boolean {
        let absolute = value;
        try {
            absolute = new URL(value, window.location.href).href;
        } catch {
            // Keep the original relative value for pattern matching.
        }
        return this.ignoreUrls.some((pattern) =>
            typeof pattern === 'string'
                ? absolute.includes(pattern)
                : resetAndTest(pattern, absolute),
        );
    }

    private pruneRecentErrors(now: number): void {
        if (this.recentlySent.size <= MAX_RECENT_ERRORS) return;
        for (const [key, sentAt] of this.recentlySent) {
            if (now - sentAt >= this.dedupeWindowMs) {
                this.recentlySent.delete(key);
            }
            if (this.recentlySent.size <= MAX_RECENT_ERRORS) break;
        }
    }
}

function normalizeReplayOptions(
    value: boolean | RumSessionReplayOptions | undefined,
): RumSessionReplayOptions {
    return typeof value === 'object' ? value : { enabled: value === true };
}

export function normalizePerformanceOptions(
    value: boolean | RumPerformanceOptions | undefined,
): RumPerformanceOptions & { enabled: boolean } {
    if (typeof value === 'object') {
        return { ...value, enabled: value.enabled === true };
    }
    return { enabled: value === true };
}

function normalizeError(value: unknown): Error {
    if (value instanceof Error) return value;
    if (typeof value === 'string') return new Error(value);
    try {
        return new Error(JSON.stringify(value));
    } catch {
        return new Error(String(value));
    }
}

function createDedupeKey(
    category: RumErrorCategory,
    type: string,
    message: string,
    options: RumCaptureErrorOptions,
): string {
    return [
        category,
        type,
        message,
        options.http?.method,
        options.http?.url,
        options.http?.status,
        options.resource?.tagName,
        options.resource?.url,
        options.vue?.componentName,
    ].join('\u0000');
}

function createEventId(prefix: string): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function cleanOptional(value: string | undefined, maxLength: number) {
    if (!value) return undefined;
    const clean = sanitizeText(value, maxLength);
    return clean || undefined;
}

function resetAndTest(pattern: RegExp, value: string): boolean {
    pattern.lastIndex = 0;
    return pattern.test(value);
}
