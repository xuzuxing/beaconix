export type RumTransportPath = 'errors' | 'events' | 'replays';

export interface RumTransport {
    send(
        path: RumTransportPath,
        payload: Record<string, unknown>,
    ): Promise<boolean>;
}

export class FetchRumTransport implements RumTransport {
    readonly endpoint: string;

    constructor(
        endpoint: string,
        private readonly publicKey: string,
    ) {
        this.endpoint = endpoint.replace(/\/$/, '');
    }

    async send(
        path: RumTransportPath,
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
