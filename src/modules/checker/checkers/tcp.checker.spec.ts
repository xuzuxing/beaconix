import { createServer } from 'node:net';
import type { Server, AddressInfo } from 'node:net';
import { parseTcpTarget, TcpChecker } from './tcp.checker';

// 本文件连接 loopback；本地检查器默认阻断私网目标，这里显式放行。
process.env.MONITOR_ALLOW_PRIVATE_TARGETS = 'true';

describe('parseTcpTarget', () => {
    it('parses host:port', () => {
        expect(parseTcpTarget('db.internal:5432')).toEqual({
            host: 'db.internal',
            port: 5432,
        });
    });

    it('parses a bracketed IPv6 literal', () => {
        expect(parseTcpTarget('[::1]:6379')).toEqual({
            host: '::1',
            port: 6379,
        });
    });

    it.each([
        'db.internal',
        'db.internal:',
        ':5432',
        'db.internal:0',
        'db.internal:70000',
    ])('rejects "%s"', (target) => {
        expect(parseTcpTarget(target)).toBeNull();
    });
});

describe('TcpChecker', () => {
    const checker = new TcpChecker();
    let server: Server;
    let port: number;

    beforeAll(async () => {
        server = createServer();
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
        );
        port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('connects to an open port', async () => {
        const result = await checker.check(`127.0.0.1:${port}`, 2000);

        expect(result.success).toBe(true);
        expect(result.error).toBeNull();
    });

    it('fails to connect to a closed port', async () => {
        const closedPort = port === 1 ? 2 : 1;
        const result = await checker.check(`127.0.0.1:${closedPort}`, 2000);

        expect(result.success).toBe(false);
        expect(result.error).not.toBeNull();
    });

    it('reports an invalid target', async () => {
        const result = await checker.check('not-a-target', 2000);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid host:port target');
    });
});
