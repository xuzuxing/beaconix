export interface RumSessionReplayOptions {
    enabled: boolean;
    /** Masks every text node in DOM snapshots and mutations. Default: true. */
    maskText?: boolean;
    flushIntervalMs?: number;
    maxBatchEvents?: number;
    /** Conservative client-side chunk limit. Default: 48 KiB. */
    maxPayloadBytes?: number;
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
    sessionReplay?: boolean | RumSessionReplayOptions;
}

export interface RumErrorPayload {
    type: string;
    message: string;
    stack?: string;
    page?: string;
    release?: string;
    sessionId?: string;
    occurredAt?: string;
}

type ReplayEvent = {
    type: string;
    at: string;
    data: Record<string, unknown>;
};

const DEFAULT_DEDUPE_WINDOW_MS = 60_000;
const DEFAULT_REPLAY_FLUSH_MS = 5_000;
const DEFAULT_REPLAY_BATCH = 40;
const DEFAULT_REPLAY_MAX_PAYLOAD_BYTES = 48 * 1024;
const MAX_RECENT_ERRORS = 500;
const REPLAY_PAYLOAD_OVERHEAD_BYTES = 4 * 1024;

export class RumBrowserClient {
    private readonly endpoint: string;
    private readonly publicKey: string;
    private readonly release?: string;
    private readonly userId?: string;
    private readonly anonymousId?: string;
    private readonly sessionId: string;
    private readonly sampleRate: number;
    private readonly dedupeWindowMs: number;
    private readonly recentlySent = new Map<string, number>();
    private readonly replay: Required<RumSessionReplayOptions>;
    private readonly replayStartedAt = new Date().toISOString();
    private replayEvents: ReplayEvent[] = [];
    private replaySequence = 0;
    private replayTimer: number | null = null;
    private replayFlush: Promise<void> | null = null;
    private mutationObserver: MutationObserver | null = null;
    private lastScrollAt = 0;
    private initialized = false;

    private readonly onError = (event: ErrorEvent) => {
        void this.captureError(event.error ?? new Error(event.message), {
            type: 'error',
        });
    };
    private readonly onUnhandledRejection = (event: PromiseRejectionEvent) => {
        const reason = event.reason;
        const error =
            reason instanceof Error ? reason : new Error(String(reason));
        void this.captureError(error, { type: 'unhandledrejection' });
    };
    private readonly onClick = (event: MouseEvent) => {
        this.recordReplay('click', {
            x: Math.round(event.clientX),
            y: Math.round(event.clientY),
            target: this.targetSelector(event.target),
        });
    };
    private readonly onInput = (event: Event) => {
        const target = event.target as HTMLInputElement | null;
        this.recordReplay('input', {
            target: this.targetSelector(target),
            inputType: target?.type ?? null,
            value: '[REDACTED]',
            valueLength:
                typeof target?.value === 'string' ? target.value.length : 0,
        });
    };
    private readonly onScroll = () => {
        const now = Date.now();
        if (now - this.lastScrollAt < 250) return;
        this.lastScrollAt = now;
        this.recordReplay('scroll', {
            x: Math.round(window.scrollX),
            y: Math.round(window.scrollY),
        });
    };
    private readonly onNavigation = () => {
        this.recordReplay('navigation', { page: this.page() });
    };
    private readonly onPageHide = () => {
        void this.flushReplay();
    };

    constructor(options: RumBrowserOptions) {
        if (!options.endpoint) throw new Error('RUM endpoint is required');
        if (!options.publicKey) throw new Error('RUM publicKey is required');
        const sampleRate = options.sampleRate ?? 1;
        if (sampleRate < 0 || sampleRate > 1) {
            throw new Error('RUM sampleRate must be between 0 and 1');
        }
        const replayOptions =
            typeof options.sessionReplay === 'object'
                ? options.sessionReplay
                : { enabled: options.sessionReplay === true };
        this.endpoint = options.endpoint.replace(/\/$/, '');
        this.publicKey = options.publicKey;
        this.release = options.release;
        this.userId = options.userId;
        this.anonymousId = options.anonymousId;
        this.sessionId = options.sessionId || createSessionId();
        if (!/^[A-Za-z0-9_-]{8,100}$/.test(this.sessionId)) {
            throw new Error('RUM sessionId must be 8-100 URL-safe characters');
        }
        this.sampleRate = sampleRate;
        this.dedupeWindowMs =
            options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
        if (!Number.isFinite(this.dedupeWindowMs) || this.dedupeWindowMs < 0) {
            throw new Error('RUM dedupeWindowMs must be zero or greater');
        }
        const flushIntervalMs =
            replayOptions.flushIntervalMs ?? DEFAULT_REPLAY_FLUSH_MS;
        const maxBatchEvents =
            replayOptions.maxBatchEvents ?? DEFAULT_REPLAY_BATCH;
        const maxPayloadBytes =
            replayOptions.maxPayloadBytes ?? DEFAULT_REPLAY_MAX_PAYLOAD_BYTES;
        if (!Number.isFinite(flushIntervalMs) || flushIntervalMs < 1_000) {
            throw new Error('RUM replay flushIntervalMs must be at least 1000');
        }
        if (
            !Number.isInteger(maxBatchEvents) ||
            maxBatchEvents < 1 ||
            maxBatchEvents > 200
        ) {
            throw new Error(
                'RUM replay maxBatchEvents must be between 1 and 200',
            );
        }
        if (
            !Number.isInteger(maxPayloadBytes) ||
            maxPayloadBytes < 8 * 1024 ||
            maxPayloadBytes > 1024 * 1024
        ) {
            throw new Error(
                'RUM replay maxPayloadBytes must be between 8192 and 1048576',
            );
        }
        this.replay = {
            enabled: replayOptions.enabled,
            maskText: replayOptions.maskText ?? true,
            flushIntervalMs,
            maxBatchEvents,
            maxPayloadBytes,
        };
    }

    init(): () => void {
        if (this.initialized) return () => this.destroy();
        this.initialized = true;
        window.addEventListener('error', this.onError);
        window.addEventListener(
            'unhandledrejection',
            this.onUnhandledRejection,
        );
        if (this.replay.enabled) this.startReplay();
        return () => this.destroy();
    }

    destroy(): void {
        if (!this.initialized) return;
        window.removeEventListener('error', this.onError);
        window.removeEventListener(
            'unhandledrejection',
            this.onUnhandledRejection,
        );
        this.stopReplay();
        this.initialized = false;
    }

    getSessionId(): string {
        return this.sessionId;
    }

    async captureError(
        error: Error,
        options: { type?: string } = {},
    ): Promise<void> {
        if (Math.random() > this.sampleRate) return;
        const type = options.type ?? error.name ?? 'Error';
        const message = error.message || String(error);
        const fingerprint = `${type}\u0000${message}`;
        const now = Date.now();
        const lastSent = this.recentlySent.get(fingerprint);
        if (lastSent && now - lastSent < this.dedupeWindowMs) return;
        this.recentlySent.set(fingerprint, now);
        this.pruneRecentErrors(now);

        await this.send('errors', {
            type,
            message,
            stack: error.stack,
            page: this.page(),
            release: this.release,
            sessionId: this.replay.enabled ? this.sessionId : undefined,
            occurredAt: new Date(now).toISOString(),
        });
    }

    async captureEvent(
        eventName: string,
        properties: Record<string, unknown> = {},
    ): Promise<void> {
        if (!/^[A-Za-z0-9._:-]{1,100}$/.test(eventName)) {
            throw new Error('Invalid RUM event name');
        }
        await this.send('events', {
            eventName,
            userId: this.userId,
            anonymousId: this.anonymousId,
            sessionId: this.sessionId,
            release: this.release,
            page: this.page(),
            properties,
            occurredAt: new Date().toISOString(),
        });
    }

    private startReplay(): void {
        this.recordReplay('snapshot', {
            page: this.page(),
            viewport: {
                width: window.innerWidth,
                height: window.innerHeight,
            },
            html: this.snapshotHtml(),
        });
        window.addEventListener('click', this.onClick, true);
        window.addEventListener('input', this.onInput, true);
        window.addEventListener('scroll', this.onScroll, true);
        window.addEventListener('popstate', this.onNavigation);
        window.addEventListener('hashchange', this.onNavigation);
        window.addEventListener('pagehide', this.onPageHide);
        this.mutationObserver = new MutationObserver((records) => {
            const mutations = records.slice(0, 20).map((record) => ({
                type: record.type,
                target: this.targetSelector(record.target),
                attribute:
                    record.type === 'attributes'
                        ? record.attributeName
                        : undefined,
                added: Array.from(record.addedNodes)
                    .slice(0, 5)
                    .map((node) => this.serializeNode(node)),
                removed: record.removedNodes.length,
                text: record.type === 'characterData' ? '[MASKED]' : undefined,
            }));
            this.recordReplay('mutation', { mutations });
        });
        this.mutationObserver.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
            attributeFilter: [
                'class',
                'style',
                'hidden',
                'aria-expanded',
                'aria-hidden',
            ],
        });
        this.replayTimer = window.setInterval(
            () => void this.flushReplay(),
            this.replay.flushIntervalMs,
        );
    }

    private stopReplay(): void {
        if (!this.replay.enabled) return;
        window.removeEventListener('click', this.onClick, true);
        window.removeEventListener('input', this.onInput, true);
        window.removeEventListener('scroll', this.onScroll, true);
        window.removeEventListener('popstate', this.onNavigation);
        window.removeEventListener('hashchange', this.onNavigation);
        window.removeEventListener('pagehide', this.onPageHide);
        this.mutationObserver?.disconnect();
        this.mutationObserver = null;
        if (this.replayTimer !== null) window.clearInterval(this.replayTimer);
        this.replayTimer = null;
        void this.flushReplay();
    }

    private recordReplay(type: string, data: Record<string, unknown>): void {
        if (!this.replay.enabled) return;
        this.replayEvents.push({ type, at: new Date().toISOString(), data });
        if (this.replayEvents.length >= this.replay.maxBatchEvents)
            void this.flushReplay();
    }

    private flushReplay(): Promise<void> {
        if (this.replayFlush) return this.replayFlush;
        this.replayFlush = this.flushReplayQueue().finally(() => {
            this.replayFlush = null;
        });
        return this.replayFlush;
    }

    private async flushReplayQueue(): Promise<void> {
        while (this.replayEvents.length) {
            const events = this.takeReplayBatch();
            const sequence = this.replaySequence;
            const sent = await this.send('replays', {
                sessionId: this.sessionId,
                sequence,
                events,
                startedAt: this.replayStartedAt,
                occurredAt: new Date().toISOString(),
                release: this.release,
                page: this.page(),
            });
            if (!sent) {
                this.replayEvents.unshift(...events);
                return;
            }
            this.replaySequence += 1;
        }
    }

    private takeReplayBatch(): ReplayEvent[] {
        const payloadBudget = Math.max(
            1,
            this.replay.maxPayloadBytes - REPLAY_PAYLOAD_OVERHEAD_BYTES,
        );
        let count = 0;
        let sizeBytes = 2;
        while (
            count < this.replayEvents.length &&
            count < this.replay.maxBatchEvents
        ) {
            const event = this.replayEvents[count];
            const eventSize = utf8Size(JSON.stringify(event)) + (count ? 1 : 0);
            if (count > 0 && sizeBytes + eventSize > payloadBudget) break;
            if (count === 0 && eventSize > payloadBudget) {
                this.replayEvents[0] = {
                    type: 'truncated',
                    at: event.at,
                    data: {
                        originalType: event.type,
                        reason: 'event exceeded replay payload limit',
                    },
                };
                return this.replayEvents.splice(0, 1);
            }
            sizeBytes += eventSize;
            count += 1;
        }
        return this.replayEvents.splice(0, Math.max(1, count));
    }

    private snapshotHtml(): string | null {
        try {
            const clone = document.documentElement.cloneNode(true) as Element;
            this.sanitizeElement(clone);
            const html = clone.outerHTML;
            return html.length <= 40_000 ? html : null;
        } catch {
            return null;
        }
    }

    private serializeNode(node: Node): string | null {
        if (node.nodeType === Node.TEXT_NODE) return '[MASKED]';
        if (!(node instanceof Element)) return null;
        if (/^(?:script|noscript|iframe|object|embed)$/i.test(node.tagName))
            return null;
        const clone = node.cloneNode(true) as Element;
        this.sanitizeElement(clone);
        return clone.outerHTML.slice(0, 2_000);
    }

    private sanitizeElement(root: Element): void {
        root.querySelectorAll('script,noscript,iframe,object,embed').forEach(
            (nested) => nested.remove(),
        );
        const controls = [
            ...(root.matches('input,textarea,select') ? [root] : []),
            ...Array.from(root.querySelectorAll('input,textarea,select')),
        ];
        controls.forEach((nested) => {
            nested.setAttribute('value', '[REDACTED]');
            nested.removeAttribute('checked');
            nested.removeAttribute('selected');
            nested.textContent = '';
        });
        const elements = [root, ...Array.from(root.querySelectorAll('*'))];
        elements.forEach((element) => {
            for (const attribute of Array.from(element.attributes)) {
                if (/^on/i.test(attribute.name))
                    element.removeAttribute(attribute.name);
                if (
                    /^(?:href|src|action|formaction|poster)$/i.test(
                        attribute.name,
                    )
                )
                    element.setAttribute(
                        attribute.name,
                        stripUrl(attribute.value),
                    );
                if (/^(?:srcset)$/i.test(attribute.name))
                    element.setAttribute(attribute.name, '[REDACTED]');
                if (/^(?:style)$/i.test(attribute.name))
                    element.setAttribute(
                        attribute.name,
                        sanitizeStyle(attribute.value),
                    );
                if (
                    /^(?:value|srcdoc|nonce)$/i.test(attribute.name) ||
                    /(?:password|passwd|token|authorization|cookie|secret|api[_-]?key|email|phone|mobile|card|cvv|session)/i.test(
                        attribute.name,
                    )
                )
                    element.setAttribute(attribute.name, '[REDACTED]');
                if (
                    this.replay.maskText &&
                    /^(?:aria-label|aria-description|title|placeholder|alt)$/i.test(
                        attribute.name,
                    )
                )
                    element.setAttribute(attribute.name, '[MASKED]');
            }
        });
        if (this.replay.maskText) maskTextNodes(root);
    }

    private targetSelector(target: EventTarget | Node | null): string | null {
        if (!(target instanceof Element)) return null;
        const id = target.id ? `#${safeSelector(target.id)}` : '';
        const classes = Array.from(target.classList)
            .slice(0, 3)
            .map((value) => `.${safeSelector(value)}`)
            .join('');
        return `${target.tagName.toLowerCase()}${id}${classes}`.slice(0, 300);
    }

    private page(): string {
        return `${window.location.origin}${window.location.pathname}`;
    }

    private pruneRecentErrors(now: number): void {
        if (this.recentlySent.size <= MAX_RECENT_ERRORS) return;
        for (const [key, sentAt] of this.recentlySent) {
            if (now - sentAt >= this.dedupeWindowMs)
                this.recentlySent.delete(key);
            if (this.recentlySent.size <= MAX_RECENT_ERRORS) break;
        }
    }

    private async send(
        path: 'errors' | 'events' | 'replays',
        payload: Record<string, unknown>,
    ): Promise<boolean> {
        try {
            const response = await fetch(`${this.endpoint}/${path}`, {
                method: 'POST',
                credentials: 'omit',
                keepalive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    publicKey: this.publicKey,
                    ...payload,
                }),
            });
            return response.ok;
        } catch {
            // Observability must never break the host application.
            return false;
        }
    }
}

function createSessionId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID)
        return crypto.randomUUID();
    return `rum_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function stripUrl(value: string): string {
    if (/^(?:data|javascript|blob):/i.test(value.trim())) return '[REDACTED]';
    try {
        const url = new URL(value, window.location.href);
        return `${url.origin}${url.pathname}`;
    } catch {
        return value.split(/[?#]/, 1)[0];
    }
}

function sanitizeStyle(value: string): string {
    return value.replace(/url\((['"]?)(.*?)\1\)/gi, (_match, quote, url) => {
        return `url(${quote}${stripUrl(String(url))}${quote})`;
    });
}

function utf8Size(value: string): number {
    if (typeof TextEncoder !== 'undefined')
        return new TextEncoder().encode(value).length;
    return new Blob([value]).size;
}

function maskTextNodes(root: Element): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
        if (node.textContent?.trim()) node.textContent = '[MASKED]';
        node = walker.nextNode();
    }
}

function safeSelector(value: string): string {
    return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function initRum(options: RumBrowserOptions): RumBrowserClient {
    const client = new RumBrowserClient(options);
    client.init();
    return client;
}
