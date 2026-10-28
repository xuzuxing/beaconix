import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { HttpChecker } from './http.checker';

// 本文件用 loopback 起真实服务器；本地检查器默认阻断私网目标，这里显式放行。
process.env.MONITOR_ALLOW_PRIVATE_TARGETS = 'true';

/** Loopback-only real fetch/stream coverage; no project DB, Redis or external targets. */
describe('HTTP assertion transport integration', () => {
    let server: Server;
    let target: string;
    const checker = new HttpChecker();

    beforeAll(async () => {
        server = createServer((request, response) => {
            if (request.url === '/json') {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.write('{"padding":"' + 'x'.repeat(600) + '",');
                response.end('"data":{"status":"ok"}}');
            } else if (request.url === '/large') {
                response.end('x'.repeat(2048));
            } else if (request.url === '/compressed') {
                const compressed = gzipSync('x'.repeat(2048));
                response.writeHead(200, {
                    'content-encoding': 'gzip',
                    'content-length': compressed.length,
                });
                response.end(compressed);
            } else {
                response.writeHead(200);
                response.write('healthy');
                // A hanging body is terminated by the check's own deadline.
            }
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
        const closed = new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
        server.closeAllConnections();
        await closed;
    });

    it('evaluates JSON and a keyword past the old prefix with real fetch', async () => {
        const result = await checker.check(`${target}/json`, 1000, 200, {
            config: {
                keyword: '"status":"ok"',
                jsonAssertions: [
                    { path: '/data/status', operator: 'eq', value: 'ok' },
                ],
            },
        });
        expect(result).toMatchObject({
            success: true,
            meta: { bodyTruncated: false },
        });
        expect(result.bodyContains).toHaveLength(512);
        expect(result.bodyContains).not.toContain('"status"');
    });

    it('enforces the body limit on a real response', async () => {
        const result = await checker.check(`${target}/large`, 1000, 200, {
            config: { keyword: 'x', maxBodyBytes: 1024 },
        });
        expect(result).toMatchObject({
            success: false,
            failureKind: 'ASSERTION',
            meta: { assertionFailure: 'BODY_LIMIT' },
        });
    });

    it('aborts a real stalled response within its overall deadline', async () => {
        const result = await checker.check(`${target}/stall`, 100, 200, {
            config: { keyword: 'healthy' },
        });
        expect(result).toMatchObject({
            success: false,
            failureKind: 'TIMEOUT',
        });
    });

    it('limits decompressed response bytes rather than compressed Content-Length', async () => {
        const result = await checker.check(`${target}/compressed`, 1000, 200, {
            config: { keyword: 'x', maxBodyBytes: 1024 },
        });
        expect(result).toMatchObject({
            success: false,
            failureKind: 'ASSERTION',
            meta: { assertionFailure: 'BODY_LIMIT', bodyBytes: 2048 },
        });
    });
});
