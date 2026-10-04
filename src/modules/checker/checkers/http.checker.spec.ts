import { HttpChecker } from './http.checker';

interface FakeResponse {
    status: number;
    arrayBuffer?: () => Promise<ArrayBuffer>;
}

function mockFetch(implementation: () => Promise<unknown>) {
    const spy = jest.fn(implementation);
    global.fetch = spy as unknown as typeof fetch;
    return spy;
}

function response(status: number): FakeResponse {
    return {
        status,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
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
