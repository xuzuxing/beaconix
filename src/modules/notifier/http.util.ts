const DEFAULT_TIMEOUT_MS = 5000;

export type JsonObject = Record<string, unknown>;

async function parseBody(response: Response): Promise<JsonObject> {
    const text = await response.text();

    if (text === '') return {};

    try {
        return JSON.parse(text) as JsonObject;
    } catch {
        return { raw: text };
    }
}

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return 'unknown-host';
    }
}

/** POSTs a JSON body and returns the parsed response, throwing on non-2xx. */
export async function postJson(
    url: string,
    body: unknown,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<JsonObject> {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });

    const parsed = await parseBody(response);

    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status} from ${hostOf(url)}: ${JSON.stringify(parsed).slice(0, 200)}`,
        );
    }

    return parsed;
}

/** GETs a URL and returns the parsed response, throwing on non-2xx. */
export async function getJson(
    url: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<JsonObject> {
    const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
    });

    const parsed = await parseBody(response);

    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status} from ${hostOf(url)}: ${JSON.stringify(parsed).slice(0, 200)}`,
        );
    }

    return parsed;
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
            const message =
                (typeof result.msg === 'string' && result.msg) ||
                (typeof result.errmsg === 'string' && result.errmsg) ||
                'unknown error';
            throw new Error(
                `${provider} rejected the message: ${code} (${message})`,
            );
        }
    }
}
