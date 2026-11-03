export interface RumBrowserOptions {
    endpoint: string;
    publicKey: string;
    sampleRate?: number;
    dedupeWindowMs?: number;
}

export interface RumErrorPayload {
    type: string;
    message: string;
    stack?: string;
    page?: string;
    occurredAt?: string;
}

const DEFAULT_DEDUPE_WINDOW_MS = 60_000;

export class RumBrowserClient {
    private readonly endpoint: string;
    private readonly publicKey: string;
    private readonly sampleRate: number;
    private readonly dedupeWindowMs: number;
    private readonly recentlySent = new Map<string, number>();
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

    constructor(options: RumBrowserOptions) {
        if (!options.endpoint) throw new Error('RUM endpoint is required');
        if (!options.publicKey) throw new Error('RUM publicKey is required');
        const sampleRate = options.sampleRate ?? 1;
        if (sampleRate < 0 || sampleRate > 1) {
            throw new Error('RUM sampleRate must be between 0 and 1');
        }
        this.endpoint = options.endpoint.replace(/\/$/, '');
        this.publicKey = options.publicKey;
        this.sampleRate = sampleRate;
        this.dedupeWindowMs =
            options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    }

    init(): () => void {
        if (this.initialized) return () => this.destroy();
        this.initialized = true;
        window.addEventListener('error', this.onError);
        window.addEventListener(
            'unhandledrejection',
            this.onUnhandledRejection,
        );
        return () => this.destroy();
    }

    destroy(): void {
        if (!this.initialized) return;
        window.removeEventListener('error', this.onError);
        window.removeEventListener(
            'unhandledrejection',
            this.onUnhandledRejection,
        );
        this.initialized = false;
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

        await this.send({
            type,
            message,
            stack: error.stack,
            page: `${window.location.origin}${window.location.pathname}`,
            occurredAt: new Date(now).toISOString(),
        });
    }

    private async send(payload: RumErrorPayload): Promise<void> {
        try {
            await fetch(`${this.endpoint}/errors`, {
                method: 'POST',
                credentials: 'omit',
                keepalive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    publicKey: this.publicKey,
                    ...payload,
                }),
            });
        } catch {
            // Observability must never break the host application.
        }
    }
}

export function initRum(options: RumBrowserOptions): RumBrowserClient {
    const client = new RumBrowserClient(options);
    client.init();
    return client;
}
