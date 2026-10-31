import { Agent } from 'undici';
import {
    pinnedLookup,
    resolvePublicHost,
} from '../../common/utils/address.util';
import { parseNotificationUrl } from './notification-url';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 65_536;
class NotificationHttpError extends Error {}

export type JsonObject = Record<string, unknown>;

async function parseBody(
    response: Response,
    signal: AbortSignal,
): Promise<JsonObject> {
    const reader = response.body?.getReader();
    if (!reader) return {};
    const chunks: Uint8Array[] = [];
    let size = 0;
    const abort = () => {
        void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
        for (;;) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                throw new NotificationHttpError(
                    'Notification response exceeds the size limit',
                );
            }
            chunks.push(value);
        }
    } finally {
        signal.removeEventListener('abort', abort);
        reader.releaseLock();
    }
    const text = Buffer.concat(chunks).toString('utf8');

    if (text === '') return {};

    try {
        return JSON.parse(text) as JsonObject;
    } catch {
        return { raw: text };
    }
}

/** Resolve once, pin the socket, and never forward a credential-bearing request. */
async function requestJson(
    url: string,
    method: 'POST' | 'GET',
    body: unknown,
    timeoutMs: number,
): Promise<JsonObject> {
    const target = parseNotificationUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let dispatcher: Agent | undefined;
    try {
        // The monitor's self-hosted LAN override must never authorize tenant
        // notification requests into the platform's private network.
        const address = await resolvePublicHost(
            target.hostname,
            controller.signal,
            { allowPrivate: false },
        );
        if (!address.ok)
            throw new NotificationHttpError(
                'Notification destination must resolve only to public addresses',
            );
        controller.signal.throwIfAborted();
        dispatcher = new Agent({ connect: { lookup: pinnedLookup(address) } });
        const options = {
            method,
            redirect: 'manual' as const,
            dispatcher,
            signal: controller.signal,
            ...(method === 'POST'
                ? {
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify(body),
                  }
                : {}),
        };
        const response = await fetch(target, options);
        if (!response.ok) {
            await response.body?.cancel();
            throw new NotificationHttpError(
                `HTTP ${response.status} from notification endpoint`,
            );
        }
        return await parseBody(response, controller.signal);
    } catch (error) {
        if (error instanceof NotificationHttpError) throw error;
        // eslint-disable-next-line preserve-caught-error -- Transport causes and remote messages may contain channel credentials.
        throw new Error(
            controller.signal.aborted
                ? 'Notification request timed out'
                : 'Notification request failed',
        );
    } finally {
        clearTimeout(timer);
        controller.abort();
        await dispatcher?.destroy();
    }
}

/** POSTs JSON to a public, pinned destination without following redirects. */
export function postJson(
    url: string,
    body: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<JsonObject> {
    return requestJson(url, 'POST', body, timeoutMs);
}

/** GETs a URL and returns the parsed response, throwing on non-2xx. */
export function getJson(
    url: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<JsonObject> {
    return requestJson(url, 'GET', undefined, timeoutMs);
}

/**
 * Webhook APIs answer 200 with an application-level error code. Throws when any
 * of the given numeric code fields is non-zero.
 */
export function assertZeroCode(
    result: JsonObject,
    keys: string[],
    provider: string,
): void {
    for (const key of keys) {
        const code = result[key];
        if (typeof code === 'number' && code !== 0) {
            throw new Error(`${provider} rejected the message: ${code}`);
        }
    }
}
