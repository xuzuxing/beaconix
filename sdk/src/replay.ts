import {
    sanitizeStyle,
    stripUrl,
    targetSelector,
    utf8Size,
} from './sanitizer.js';
import type { RumSessionReplayOptions } from './types.js';
import type { RumTransport } from './transport.js';

type ReplayEvent = {
    type: string;
    at: string;
    data: Record<string, unknown>;
};

const DEFAULT_REPLAY_FLUSH_MS = 5_000;
const DEFAULT_REPLAY_BATCH = 40;
const DEFAULT_REPLAY_MAX_PAYLOAD_BYTES = 48 * 1024;
const REPLAY_PAYLOAD_OVERHEAD_BYTES = 4 * 1024;

export class RumReplayRecorder {
    private readonly options: Required<RumSessionReplayOptions>;
    private readonly startedAt = new Date().toISOString();
    private events: ReplayEvent[] = [];
    private sequence = 0;
    private timer: number | null = null;
    private flushPromise: Promise<void> | null = null;
    private mutationObserver: MutationObserver | null = null;
    private lastScrollAt = 0;
    private started = false;

    constructor(
        options: RumSessionReplayOptions,
        private readonly transport: RumTransport,
        private readonly sessionId: string,
        private readonly release: string | undefined,
        private readonly currentPage: () => string,
    ) {
        const flushIntervalMs =
            options.flushIntervalMs ?? DEFAULT_REPLAY_FLUSH_MS;
        const maxBatchEvents = options.maxBatchEvents ?? DEFAULT_REPLAY_BATCH;
        const maxPayloadBytes =
            options.maxPayloadBytes ?? DEFAULT_REPLAY_MAX_PAYLOAD_BYTES;
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
        this.options = {
            enabled: options.enabled,
            maskText: options.maskText ?? true,
            flushIntervalMs,
            maxBatchEvents,
            maxPayloadBytes,
        };
    }

    start(): void {
        if (!this.options.enabled || this.started) return;
        this.started = true;
        this.record('snapshot', {
            page: this.currentPage(),
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
                target: targetSelector(record.target),
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
            this.record('mutation', { mutations });
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
        this.timer = window.setInterval(
            () => void this.flush(),
            this.options.flushIntervalMs,
        );
    }

    stop(): void {
        if (!this.started) return;
        window.removeEventListener('click', this.onClick, true);
        window.removeEventListener('input', this.onInput, true);
        window.removeEventListener('scroll', this.onScroll, true);
        window.removeEventListener('popstate', this.onNavigation);
        window.removeEventListener('hashchange', this.onNavigation);
        window.removeEventListener('pagehide', this.onPageHide);
        this.mutationObserver?.disconnect();
        this.mutationObserver = null;
        if (this.timer !== null) window.clearInterval(this.timer);
        this.timer = null;
        this.started = false;
        void this.flush();
    }

    flush(): Promise<void> {
        if (this.flushPromise) return this.flushPromise;
        this.flushPromise = this.flushQueue().finally(() => {
            this.flushPromise = null;
        });
        return this.flushPromise;
    }

    private readonly onClick = (event: MouseEvent) => {
        this.record('click', {
            x: Math.round(event.clientX),
            y: Math.round(event.clientY),
            target: targetSelector(event.target),
        });
    };

    private readonly onInput = (event: Event) => {
        const target = event.target as HTMLInputElement | null;
        this.record('input', {
            target: targetSelector(target),
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
        this.record('scroll', {
            x: Math.round(window.scrollX),
            y: Math.round(window.scrollY),
        });
    };

    private readonly onNavigation = () => {
        this.record('navigation', { page: this.currentPage() });
    };

    private readonly onPageHide = () => {
        void this.flush();
    };

    private record(type: string, data: Record<string, unknown>): void {
        if (!this.options.enabled) return;
        this.events.push({ type, at: new Date().toISOString(), data });
        if (this.events.length >= this.options.maxBatchEvents)
            void this.flush();
    }

    private async flushQueue(): Promise<void> {
        while (this.events.length) {
            const events = this.takeBatch();
            const sent = await this.transport.send('replays', {
                sessionId: this.sessionId,
                sequence: this.sequence,
                events,
                startedAt: this.startedAt,
                occurredAt: new Date().toISOString(),
                release: this.release,
                page: this.currentPage(),
            });
            if (!sent) {
                this.events.unshift(...events);
                return;
            }
            this.sequence += 1;
        }
    }

    private takeBatch(): ReplayEvent[] {
        const payloadBudget = Math.max(
            1,
            this.options.maxPayloadBytes - REPLAY_PAYLOAD_OVERHEAD_BYTES,
        );
        let count = 0;
        let sizeBytes = 2;
        while (
            count < this.events.length &&
            count < this.options.maxBatchEvents
        ) {
            const event = this.events[count];
            const eventSize = utf8Size(JSON.stringify(event)) + (count ? 1 : 0);
            if (count > 0 && sizeBytes + eventSize > payloadBudget) break;
            if (count === 0 && eventSize > payloadBudget) {
                this.events[0] = {
                    type: 'truncated',
                    at: event.at,
                    data: {
                        originalType: event.type,
                        reason: 'event exceeded replay payload limit',
                    },
                };
                return this.events.splice(0, 1);
            }
            sizeBytes += eventSize;
            count += 1;
        }
        return this.events.splice(0, Math.max(1, count));
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
        if (/^(?:script|noscript|iframe|object|embed)$/i.test(node.tagName)) {
            return null;
        }
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
                if (/^on/i.test(attribute.name)) {
                    element.removeAttribute(attribute.name);
                } else if (
                    /^(?:href|src|action|formaction|poster)$/i.test(
                        attribute.name,
                    )
                ) {
                    element.setAttribute(
                        attribute.name,
                        stripUrl(attribute.value),
                    );
                } else if (/^srcset$/i.test(attribute.name)) {
                    element.setAttribute(attribute.name, '[REDACTED]');
                } else if (/^style$/i.test(attribute.name)) {
                    element.setAttribute(
                        attribute.name,
                        sanitizeStyle(attribute.value),
                    );
                } else if (
                    /^(?:value|srcdoc|nonce)$/i.test(attribute.name) ||
                    /(?:password|passwd|token|authorization|cookie|secret|api[_-]?key|email|phone|mobile|card|cvv|session)/i.test(
                        attribute.name,
                    )
                ) {
                    element.setAttribute(attribute.name, '[REDACTED]');
                } else if (
                    this.options.maskText &&
                    /^(?:aria-label|aria-description|title|placeholder|alt)$/i.test(
                        attribute.name,
                    )
                ) {
                    element.setAttribute(attribute.name, '[MASKED]');
                }
            }
        });
        if (this.options.maskText) maskTextNodes(root);
    }
}

function maskTextNodes(root: Element): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
        if (node.textContent?.trim()) node.textContent = '[MASKED]';
        node = walker.nextNode();
    }
}
