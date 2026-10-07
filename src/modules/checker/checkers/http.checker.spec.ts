import { HttpChecker } from './http.checker';

interface FakeResponse {
    status: number;
    text: () => Promise<string>;
}

function mockFetch(implementation: () => Promise<unknown>) {
    const spy = jest.fn(implementation);
    global.fetch = spy as unknown as typeof fetch;
    return spy;
}

function response(status: number, body = ''): FakeResponse {
    return {
        status,
        text: () => Promise.resolve(body),
    };
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
});
