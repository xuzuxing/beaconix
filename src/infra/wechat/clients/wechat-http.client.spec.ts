import {
    redactSecrets,
    redactUrl,
    WechatHttpClient,
    type WechatHttpClientOptions,
} from './wechat-http.client';
import { WechatApiError } from '../wechat.types';

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function createClient(
    overrides: Partial<WechatHttpClientOptions> = {},
): WechatHttpClient {
    return new WechatHttpClient({
        platform: 'mp',
        baseUrl: 'https://api.weixin.qq.com',
        timeoutMs: 1000,
        maxRetries: 0,
        ...overrides,
    });
}

describe('WechatHttpClient', () => {
    const originalFetch = globalThis.fetch;
    let fetchMock: jest.Mock;

    beforeEach(() => {
        fetchMock = jest.fn();
        globalThis.fetch = fetchMock;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    describe('request', () => {
        it('resolves the parsed JSON body and builds the query string', async () => {
            fetchMock.mockResolvedValue(
                jsonResponse(200, { access_token: 'tok', expires_in: 7200 }),
            );

            const client = createClient();
            const result = await client.getJson<{ access_token: string }>(
                '/cgi-bin/token',
                {
                    query: {
                        grant_type: 'client_credential',
                        appid: 'wx1',
                        secret: 'sec1',
                    },
                },
            );

            expect(result.access_token).toBe('tok');

            const calledUrl = String(fetchMock.mock.calls[0][0]);
            expect(calledUrl).toContain(
                'https://api.weixin.qq.com/cgi-bin/token?',
            );
            expect(calledUrl).toContain('appid=wx1');
            expect(calledUrl).toContain('secret=sec1');
        });

        it('uses absolute URLs without the base URL', async () => {
            fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

            const client = createClient();
            await client.getJson(
                'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
                {
                    query: { corpid: 'corp-1' },
                    platform: 'work',
                },
            );

            const calledUrl = String(fetchMock.mock.calls[0][0]);
            expect(calledUrl).toContain(
                'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
            );
            expect(calledUrl).toContain('corpid=corp-1');
        });

        it('normalizes a 200 + errcode business failure without retrying', async () => {
            fetchMock.mockResolvedValue(
                jsonResponse(200, { errcode: 40013, errmsg: 'invalid appid' }),
            );

            const client = createClient({ maxRetries: 2 });

            await expect(client.getJson('/cgi-bin/token')).rejects.toThrow(
                WechatApiError,
            );
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('retries GET requests on a 5xx response', async () => {
            // A fresh Response per attempt: a body can only be read once.
            fetchMock.mockImplementation(() =>
                Promise.resolve(jsonResponse(503, { errmsg: 'boom' })),
            );

            const client = createClient({ maxRetries: 1 });

            await expect(client.getJson('/cgi-bin/token')).rejects.toThrow(
                'boom',
            );
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('does not retry POST requests by default', async () => {
            fetchMock.mockResolvedValue(jsonResponse(503, {}));

            const client = createClient({ maxRetries: 2 });

            await expect(client.postJson('/order', { a: 1 })).rejects.toThrow(
                WechatApiError,
            );
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('wraps network failures in WechatApiError', async () => {
            fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

            const client = createClient();

            const error = await client
                .getJson('/cgi-bin/token')
                .catch((thrown: unknown) => thrown);

            expect(error).toBeInstanceOf(WechatApiError);
            expect((error as WechatApiError).message).toContain('ECONNREFUSED');
            expect((error as WechatApiError).httpStatus).toBeUndefined();
        });

        it('aborts and reports a timeout', async () => {
            fetchMock.mockImplementation(
                (_input: unknown, init?: { signal?: AbortSignal }) =>
                    new Promise((_resolve, reject) => {
                        init?.signal?.addEventListener('abort', () => {
                            const error = new Error(
                                'The operation was aborted',
                            );
                            error.name = 'AbortError';
                            reject(error);
                        });
                    }),
            );

            const client = createClient({ timeoutMs: 10 });

            await expect(client.getJson('/cgi-bin/token')).rejects.toThrow(
                'timed out',
            );
        });
    });

    describe('redaction', () => {
        it('masks sensitive query parameters', () => {
            const redacted = redactUrl(
                'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=wx1&secret=supersecret',
            );

            expect(redacted).not.toContain('supersecret');
            expect(redacted).toContain('appid=wx1');
            expect(redacted).toMatch(/secret=(\*\*\*|%2A%2A%2A)/);
        });

        it('masks nested secret fields in payloads', () => {
            const redacted = redactSecrets({
                appId: 'wx1',
                appSecret: 's3cr3t',
                nested: { access_token: 'tok', corpsecret: 'cs' },
            });

            expect(redacted).toEqual({
                appId: 'wx1',
                appSecret: '***',
                nested: { access_token: '***', corpsecret: '***' },
            });
        });
    });
});
