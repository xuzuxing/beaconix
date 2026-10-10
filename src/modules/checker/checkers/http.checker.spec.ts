import { HttpChecker } from './http.checker';

function mockFetch(implementation: () => unknown) {
    const spy = jest.fn(() => Promise.resolve(implementation()));
    global.fetch = spy as unknown as typeof fetch;
    return spy;
}

function response(status: number, body = ''): Response {
    return new Response(body, { status });
}

describe('HttpChecker', () => {
    const checker = new HttpChecker();
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    it('succeeds when the status matches', async () => {
        mockFetch(() => Promise.resolve(response(200)));

        const result = await checker.check(
            'https://example.com/health',
            1000,
            200,
        );

        expect(result.success).toBe(true);
        expect(result.error).toBeNull();
        expect(result.latency).toBeGreaterThanOrEqual(0);
        expect(result.statusCode).toBe(200);
    });

    it('captures a truncated body snippet for bodyContains rules', async () => {
        const body = 'x'.repeat(1000);
        mockFetch(() => Promise.resolve(response(200, body)));

        const result = await checker.check(
            'https://example.com/health',
            1000,
            200,
        );

        expect(result.success).toBe(true);
        expect(result.bodyContains).toBe('x'.repeat(512));
    });

    it('keeps the body snippet on a status mismatch', async () => {
        mockFetch(() => Promise.resolve(response(503, 'upstream down')));

        const result = await checker.check(
            'https://example.com/health',
            1000,
            200,
        );

        expect(result.success).toBe(false);
        expect(result.statusCode).toBe(503);
        expect(result.bodyContains).toBe('upstream down');
    });

    it('includes SSL certificate details when SSL monitoring is enabled', async () => {
        const ssl = {
            expiresAt: new Date('2026-04-05T12:00:00.000Z'),
            daysRemaining: 31,
            issuer: 'Example CA',
            subject: 'api.example.com',
        };
        mockFetch(() => Promise.resolve(response(200)));
        jest.spyOn(
            checker as unknown as {
                inspectSslCertificate: () => Promise<typeof ssl>;
            },
            'inspectSslCertificate',
        ).mockResolvedValue(ssl);

        const result = await checker.check(
            'https://example.com/health',
            1000,
            200,
            { checkSsl: true, sslExpiryThreshold: 30 },
        );

        expect(result.success).toBe(true);
        expect(result.ssl).toEqual(ssl);
    });

    it('fails when the SSL certificate is inside the expiry threshold', async () => {
        const ssl = {
            expiresAt: new Date('2026-03-10T12:00:00.000Z'),
            daysRemaining: 5,
            issuer: 'Example CA',
            subject: 'api.example.com',
        };
        mockFetch(() => Promise.resolve(response(200)));
        jest.spyOn(
            checker as unknown as {
                inspectSslCertificate: () => Promise<typeof ssl>;
            },
            'inspectSslCertificate',
        ).mockResolvedValue(ssl);

        const result = await checker.check(
            'https://example.com/health',
            1000,
            200,
            { checkSsl: true, sslExpiryThreshold: 30 },
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('SSL certificate expires in 5 day(s)');
        expect(result.ssl).toEqual(ssl);
    });

    it('fails when the status differs from the expected one', async () => {
        mockFetch(() => Promise.resolve(response(503)));

        const result = await checker.check(
            'https://example.com/health',
            1000,
            200,
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe('Unexpected status 503 (expected 200)');
        expect(result.statusCode).toBe(503);
    });

    it('fails on a transport error', async () => {
        mockFetch(() => Promise.reject(new Error('connect ECONNREFUSED')));

        const result = await checker.check(
            'https://example.com/health',
            1000,
            200,
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe('connect ECONNREFUSED');
        expect(result.statusCode).toBeNull();
    });

    it('reports a timeout as a readable error', async () => {
        mockFetch(() => {
            const error = new Error('The operation was aborted');
            error.name = 'TimeoutError';
            return Promise.reject(error);
        });

        const result = await checker.check(
            'https://example.com/health',
            1000,
            200,
        );

        expect(result.error).toBe('Request timed out');
    });

    it('rejects a malformed target without calling fetch', async () => {
        const spy = mockFetch(() => Promise.resolve(response(200)));

        const result = await checker.check('not-a-url', 1000, 200);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid URL');
        expect(spy).not.toHaveBeenCalled();
    });

    it('rejects a non-http protocol', async () => {
        const spy = mockFetch(() => Promise.resolve(response(200)));

        const result = await checker.check(
            'ftp://example.com/health',
            1000,
            200,
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('Unsupported protocol');
        expect(spy).not.toHaveBeenCalled();
    });

    it('cancels a large stream without reading the entire response', async () => {
        const cancel = jest.fn();
        const pull = jest.fn(
            (controller: ReadableStreamDefaultController<Uint8Array>) =>
                controller.enqueue(new TextEncoder().encode('x'.repeat(4096))),
        );
        mockFetch(() => new Response(new ReadableStream({ pull, cancel })));
        const result = await checker.check('https://example.com', 1000, 200);
        expect(result.bodyContains).toHaveLength(512);
        expect(result.meta).toEqual({ protocol: 'HTTP', bodyTruncated: true });
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(pull.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('times out and cancels a stalled response body', async () => {
        const cancel = jest.fn();
        mockFetch(
            () =>
                new Response(
                    new ReadableStream({
                        start() {},
                        cancel,
                    }),
                ),
        );
        const result = await checker.check('https://example.com', 30, 200);
        expect(result).toMatchObject({
            success: false,
            failureKind: 'TIMEOUT',
        });
        expect(cancel).toHaveBeenCalled();
    });

    it('does not swallow a response stream failure', async () => {
        mockFetch(
            () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.error(new Error('stream failed'));
                        },
                    }),
                ),
        );
        const result = await checker.check('https://example.com', 1000, 200);
        expect(result).toMatchObject({
            success: false,
            failureKind: 'TRANSPORT',
        });
    });

    it.each(['error', 'stall'])(
        'preserves a known HTTP assertion when the body %s occurs',
        async (mode) => {
            mockFetch(
                () =>
                    new Response(
                        new ReadableStream({
                            start(controller) {
                                if (mode === 'error')
                                    controller.error(new Error('broken body'));
                            },
                        }),
                        { status: 503 },
                    ),
            );
            const result = await checker.check('https://example.com', 30, 200);
            expect(result).toMatchObject({
                success: false,
                statusCode: 503,
                failureKind: 'ASSERTION',
            });
        },
    );

    describe('complete bounded body assertions', () => {
        it.each([false, true])(
            'keeps the legacy rule prefix independent of assertion reading (split=%s)',
            async (split) => {
                mockFetch(() => {
                    const padding = ' '.repeat(split ? 512 : 2048);
                    if (!split) return response(200, padding + 'healthy');
                    return new Response(
                        new ReadableStream({
                            start(controller) {
                                controller.enqueue(
                                    new TextEncoder().encode(padding),
                                );
                                controller.enqueue(
                                    new TextEncoder().encode('healthy'),
                                );
                                controller.close();
                            },
                        }),
                    );
                });
                const legacy = await checker.check(
                    'https://example.com',
                    1000,
                    200,
                );
                const asserted = await checker.check(
                    'https://example.com',
                    1000,
                    200,
                    {
                        config: { keyword: 'healthy' },
                    },
                );
                expect(legacy.bodyContains).toBeNull();
                expect(asserted.bodyContains).toBe(legacy.bodyContains);
                expect(asserted.success).toBe(true);
            },
        );

        it.each(['BODY_LIMIT', 'INVALID_ENCODING'])(
            'preserves header latency when the body later fails with %s',
            async (reason) => {
                let controller: ReadableStreamDefaultController<Uint8Array>;
                let headersSeen: () => void;
                const headers = new Promise<void>((resolve) => {
                    headersSeen = resolve;
                });
                const stream = new ReadableStream<Uint8Array>({
                    start(value) {
                        controller = value;
                    },
                });
                const getReader = stream.getReader.bind(stream);
                jest.spyOn(stream, 'getReader').mockImplementation(() => {
                    headersSeen();
                    return getReader();
                });
                mockFetch(() => new Response(stream));
                let now = 1000;
                jest.spyOn(Date, 'now').mockImplementation(() => now);
                const pending = checker.check(
                    'https://example.com',
                    1000,
                    200,
                    {
                        config: { keyword: 'x', maxBodyBytes: 1024 },
                    },
                );
                await headers;
                now += 250;
                controller!.enqueue(
                    reason === 'BODY_LIMIT'
                        ? new TextEncoder().encode('x'.repeat(1025))
                        : new Uint8Array([0xc3]),
                );
                controller!.close();
                expect(await pending).toMatchObject({
                    success: false,
                    latency: 0,
                    meta: { assertionFailure: reason },
                });
            },
        );

        it('runs persisted HTTP config and retains only the legacy snippet in the result', async () => {
            mockFetch(() => response(200, 'x'.repeat(600) + 'healthy'));
            const result = await checker.run({
                target: 'https://example.com',
                timeout: 1000,
                expectedStatus: 200,
                config: { keyword: 'healthy' },
            } as never);
            expect(result).toMatchObject({
                success: true,
                bodyContains: 'x'.repeat(512),
                meta: {
                    protocol: 'HTTP',
                    bodyTruncated: false,
                    bodyBytes: 607,
                    bodyLimitBytes: 65536,
                    assertions: [{ kind: 'keyword', passed: true }],
                },
            });
            expect(JSON.stringify(result.meta)).not.toContain('healthy');
        });

        it.each([
            [{ keyword: 'healthy' }, 'KEYWORD'],
            [{ keyword: 'ok', keywordMode: 'notContains' }, 'KEYWORD'],
            [
                {
                    jsonAssertions: [
                        { path: '/status', operator: 'eq', value: 'healthy' },
                    ],
                },
                'JSON_VALUE',
            ],
        ])(
            'reports a semantic assertion failure without actual values %#',
            async (config, reason) => {
                mockFetch(() =>
                    response(200, '{"status":"ok","private":"not-for-meta"}'),
                );
                const result = await checker.check(
                    'https://example.com',
                    1000,
                    200,
                    { config },
                );
                expect(result).toMatchObject({
                    success: false,
                    failureKind: 'ASSERTION',
                    statusCode: 200,
                    meta: { assertionFailure: reason },
                });
                expect(JSON.stringify(result.meta)).not.toContain(
                    'not-for-meta',
                );
            },
        );

        it('decodes Unicode across byte chunks and combines JSON and keyword assertions', async () => {
            const bytes = new TextEncoder().encode('{"status":"\u5065\u5eb7"}');
            const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
            mockFetch(
                () =>
                    new Response(
                        new ReadableStream({
                            pull(controller) {
                                const chunk = chunks.shift();
                                if (chunk) controller.enqueue(chunk);
                                else controller.close();
                            },
                        }),
                    ),
            );
            const result = await checker.check(
                'https://example.com',
                1000,
                200,
                {
                    config: {
                        keyword: '\u5065\u5eb7',
                        jsonAssertions: [
                            {
                                path: '/status',
                                operator: 'eq',
                                value: '\u5065\u5eb7',
                            },
                        ],
                    },
                },
            );
            expect(result.success).toBe(true);
            expect(result.meta).toMatchObject({
                bodyBytes: bytes.length,
                assertions: [
                    { kind: 'keyword', passed: true },
                    { kind: 'json', index: 0, passed: true },
                ],
            });
        });

        it('accepts a complete body exactly at the byte limit', async () => {
            mockFetch(() => response(200, 'x'.repeat(1024)));
            const result = await checker.check(
                'https://example.com',
                1000,
                200,
                {
                    config: { keyword: 'x', maxBodyBytes: 1024 },
                },
            );
            expect(result).toMatchObject({
                success: true,
                meta: { bodyTruncated: false, bodyBytes: 1024 },
            });
        });

        it('measures UTF-8 bytes instead of character count', async () => {
            mockFetch(() => response(200, '\u5065'.repeat(342)));
            const result = await checker.check(
                'https://example.com',
                1000,
                200,
                {
                    config: { keyword: '\u5065', maxBodyBytes: 1024 },
                },
            );
            expect(result).toMatchObject({
                success: false,
                meta: { assertionFailure: 'BODY_LIMIT', bodyBytes: 1026 },
            });
        });

        it('does not assume EOF at the exact byte limit', async () => {
            const cancel = jest.fn();
            mockFetch(
                () =>
                    new Response(
                        new ReadableStream({
                            start(controller) {
                                controller.enqueue(
                                    new TextEncoder().encode('x'.repeat(1024)),
                                );
                            },
                            cancel,
                        }),
                    ),
            );
            const result = await checker.check('https://example.com', 30, 200, {
                config: { keyword: 'x', maxBodyBytes: 1024 },
            });
            expect(result).toMatchObject({
                success: false,
                failureKind: 'TIMEOUT',
            });
            expect(cancel).toHaveBeenCalledTimes(1);
        });

        it.each(['contains', 'notContains'])(
            'rejects overflow for %s even when the prefix would satisfy the assertion',
            async (keywordMode) => {
                const cancel = jest.fn();
                let sent = false;
                mockFetch(
                    () =>
                        new Response(
                            new ReadableStream({
                                pull(controller) {
                                    if (!sent) {
                                        sent = true;
                                        controller.enqueue(
                                            new TextEncoder().encode(
                                                'x'.repeat(1025),
                                            ),
                                        );
                                    }
                                },
                                cancel,
                            }),
                        ),
                );
                const result = await checker.check(
                    'https://example.com',
                    1000,
                    200,
                    {
                        config: {
                            keyword:
                                keywordMode === 'contains' ? 'x' : 'absent',
                            keywordMode,
                            maxBodyBytes: 1024,
                        },
                    },
                );
                expect(result).toMatchObject({
                    success: false,
                    failureKind: 'ASSERTION',
                    meta: {
                        assertionFailure: 'BODY_LIMIT',
                        bodyTruncated: true,
                        bodyLimitBytes: 1024,
                    },
                });
                expect(cancel).toHaveBeenCalledTimes(1);
            },
        );

        it.each(['', '{"private":"bad-json"'])(
            'reports invalid JSON safely (%j)',
            async (body) => {
                mockFetch(() => response(200, body));
                const result = await checker.check(
                    'https://example.com',
                    1000,
                    200,
                    {
                        config: {
                            jsonAssertions: [
                                { path: '/status', operator: 'exists' },
                            ],
                        },
                    },
                );
                expect(result).toMatchObject({
                    success: false,
                    failureKind: 'ASSERTION',
                    error: 'HTTP response is not valid JSON',
                    meta: { assertionFailure: 'INVALID_JSON' },
                });
                expect(result.error).not.toContain('private');
            },
        );

        it('rejects invalid UTF-8 rather than matching replacement characters', async () => {
            mockFetch(() => new Response(new Uint8Array([0xc3])));
            const result = await checker.check(
                'https://example.com',
                1000,
                200,
                {
                    config: { keyword: '\ufffd' },
                },
            );
            expect(result).toMatchObject({
                success: false,
                failureKind: 'ASSERTION',
                meta: { assertionFailure: 'INVALID_ENCODING' },
            });
        });

        it('waits for body completion and cancels on timeout even after a keyword match', async () => {
            const cancel = jest.fn();
            mockFetch(
                () =>
                    new Response(
                        new ReadableStream({
                            start(controller) {
                                controller.enqueue(
                                    new TextEncoder().encode('healthy'),
                                );
                            },
                            cancel,
                        }),
                    ),
            );
            const result = await checker.check('https://example.com', 30, 200, {
                config: { keyword: 'healthy' },
            });
            expect(result).toMatchObject({
                success: false,
                failureKind: 'TIMEOUT',
                statusCode: 200,
            });
            expect(cancel).toHaveBeenCalledTimes(1);
        });

        it('preserves a status assertion when a configured body exceeds its limit', async () => {
            mockFetch(() => response(503, 'x'.repeat(1025)));
            expect(
                await checker.check('https://example.com', 1000, 200, {
                    config: { keyword: 'x', maxBodyBytes: 1024 },
                }),
            ).toMatchObject({
                success: false,
                failureKind: 'ASSERTION',
                statusCode: 503,
                error: 'Unexpected status 503 (expected 200)',
            });
        });

        it('retains SSL metadata alongside a failed body assertion', async () => {
            const ssl = {
                expiresAt: new Date('2030-01-01T00:00:00Z'),
                daysRemaining: 100,
                issuer: 'Fixture',
                subject: 'example.com',
            };
            mockFetch(() => response(200, 'unhealthy'));
            jest.spyOn(
                checker as unknown as {
                    inspectSslCertificate: () => Promise<typeof ssl>;
                },
                'inspectSslCertificate',
            ).mockResolvedValue(ssl);
            expect(
                await checker.check('https://example.com', 1000, 200, {
                    checkSsl: true,
                    config: { keyword: 'ready' },
                }),
            ).toMatchObject({ success: false, ssl, failureKind: 'ASSERTION' });
        });

        it('blocks invalid persisted config before any network request', async () => {
            const fetch = mockFetch(() => response(200));
            expect(
                await checker.check('https://example.com', 1000, 200, {
                    config: { keyword: 'ok', maxBodyBytes: -1 },
                }),
            ).toMatchObject({
                success: false,
                evaluated: false,
                failureKind: 'CONFIGURATION',
            });
            expect(fetch).not.toHaveBeenCalled();
        });
    });
});
