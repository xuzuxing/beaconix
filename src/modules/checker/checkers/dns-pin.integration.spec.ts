import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { lookup } from 'node:dns/promises';
import { connect } from 'node:tls';
import { EventEmitter } from 'node:events';
import { HttpChecker } from './http.checker';
import { TcpChecker } from './tcp.checker';

jest.mock('node:dns/promises', () => ({
    ...jest.requireActual('node:dns/promises'),
    lookup: jest.fn(),
}));
jest.mock('node:tls', () => ({
    ...jest.requireActual('node:tls'),
    connect: jest.fn(jest.requireActual('node:tls').connect),
}));

describe('local checker DNS pinning', () => {
    const mockLookup = jest.mocked(lookup);
    const originalPrivate = process.env.MONITOR_ALLOW_PRIVATE_TARGETS;
    let server: Server;
    let port: number;
    let receivedHost: string | undefined;

    beforeAll(async () => {
        server = createServer((request, response) => {
            receivedHost = request.headers.host;
            if (request.url === '/redirect') {
                response.writeHead(302, {
                    location: `http://next.invalid:${port}/`,
                });
            }
            response.end('healthy');
        });
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
        );
        port = (server.address() as AddressInfo).port;
    });

    beforeEach(() => {
        // Loopback fixtures exercise real transports. Public-only admission is
        // covered separately; even opted-in targets must never be re-resolved.
        process.env.MONITOR_ALLOW_PRIVATE_TARGETS = 'true';
        mockLookup.mockReset();
        mockLookup.mockResolvedValue([
            { address: '127.0.0.1', family: 4 },
        ] as never);
    });

    afterAll(async () => {
        if (originalPrivate === undefined)
            delete process.env.MONITOR_ALLOW_PRIVATE_TARGETS;
        else process.env.MONITOR_ALLOW_PRIVATE_TARGETS = originalPrivate;
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
        });
    });

    it('connects HTTP to the resolved IP while preserving the original Host', async () => {
        const result = await new HttpChecker().check(
            `http://pin.invalid:${port}/`,
            2000,
            200,
        );
        expect(result.success).toBe(true);
        expect(receivedHost).toBe(`pin.invalid:${port}`);
        expect(mockLookup).toHaveBeenCalledTimes(1);
    });

    it('resolves and pins each HTTP redirect destination separately', async () => {
        const result = await new HttpChecker().check(
            `http://pin.invalid:${port}/redirect`,
            2000,
            200,
        );
        expect(result.success).toBe(true);
        expect(receivedHost).toBe(`next.invalid:${port}`);
        expect(mockLookup.mock.calls.map(([host]) => host)).toEqual([
            'pin.invalid',
            'next.invalid',
        ]);
    });

    it('connects TCP to the checked IP without a second hostname lookup', async () => {
        const result = await new TcpChecker().check(
            `pin.invalid:${port}`,
            2000,
        );
        expect(result.success).toBe(true);
        expect(mockLookup).toHaveBeenCalledTimes(1);
    });

    it.each(['HTTP', 'TCP'])(
        'does not connect %s after DNS failure',
        async (type) => {
            mockLookup.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
            const result =
                type === 'HTTP'
                    ? await new HttpChecker().check(
                          `http://pin.invalid:${port}`,
                          500,
                          200,
                      )
                    : await new TcpChecker().check(`pin.invalid:${port}`, 500);
            expect(result).toMatchObject({
                success: false,
                failureKind: 'TRANSPORT',
            });
            expect(result.error).toContain('ENOTFOUND');
            expect(mockLookup).toHaveBeenCalledTimes(1);
        },
    );

    it('checks certificates against the original checked IP and original SNI', async () => {
        delete process.env.MONITOR_ALLOW_PRIVATE_TARGETS;
        mockLookup.mockResolvedValueOnce([
            { address: '1.1.1.1', family: 4 },
        ] as never);
        mockLookup.mockResolvedValue([
            { address: '127.0.0.1', family: 4 },
        ] as never);
        const socket = Object.assign(new EventEmitter(), {
            destroy: jest.fn(),
            getPeerCertificate: () => ({ valid_to: 'Jan 1 2099 GMT' }),
        });
        jest.mocked(connect).mockImplementationOnce(() => {
            queueMicrotask(() => socket.emit('secureConnect'));
            return socket as never;
        });
        const fetchSpy = jest
            .spyOn(global, 'fetch')
            .mockResolvedValue(new Response('healthy'));
        try {
            const result = await new HttpChecker().check(
                'https://pin.invalid/',
                2000,
                200,
                { checkSsl: true },
            );
            expect(result.success).toBe(true);
            expect(connect).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    host: '1.1.1.1',
                    servername: 'pin.invalid',
                }),
            );
            expect(mockLookup).toHaveBeenCalledTimes(1);
            expect(socket.destroy).toHaveBeenCalled();
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('blocks a redirect that resolves to a private address', async () => {
        delete process.env.MONITOR_ALLOW_PRIVATE_TARGETS;
        mockLookup.mockResolvedValueOnce([
            { address: '1.1.1.1', family: 4 },
        ] as never);
        mockLookup.mockResolvedValue([
            { address: '127.0.0.1', family: 4 },
        ] as never);
        const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
            new Response(null, {
                status: 302,
                headers: { location: 'http://internal.invalid/' },
            }),
        );
        try {
            const result = await new HttpChecker().check(
                'https://pin.invalid/',
                2000,
                200,
            );
            expect(result).toMatchObject({
                success: false,
                evaluated: false,
                failureKind: 'CONFIGURATION',
            });
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        } finally {
            fetchSpy.mockRestore();
        }
    });
});
