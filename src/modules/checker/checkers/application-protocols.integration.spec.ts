import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import {
    Server,
    ServerCredentials,
    loadPackageDefinition,
} from '@grpc/grpc-js';
import { WebSocketServer } from 'ws';
import { ConfigService } from '@nestjs/config';
import type { MonitorModel } from '../../../generated/prisma/models';
import { ApplicationCheckRuntime } from './application-runtime';
import { DockerChecker } from './docker.checker';
import { GrpcChecker, HEALTH_PACKAGE } from './grpc.checker';
import { WebsocketChecker } from './websocket.checker';

// Only tests replace destination policy. Production always uses public-address validation.
const runtime = () =>
    new ApplicationCheckRuntime({
        resolve: () => Promise.resolve('127.0.0.1'),
    });
const monitor = (
    type: string,
    target: string,
    config: object = {},
    timeout = 1000,
) =>
    ({
        type,
        target,
        config,
        timeout,
        organizationId: 'org-1',
    }) as unknown as MonitorModel;
const listen = (server: HttpServer) =>
    new Promise<number>((resolve) =>
        server.listen(0, '127.0.0.1', () =>
            resolve((server.address() as AddressInfo).port),
        ),
    );
const close = (server: HttpServer) =>
    new Promise<void>((resolve) => server.close(() => resolve()));

describe('Real local WebSocket protocol', () => {
    it('requires a matching protocol pong before success', async () => {
        const server = createServer();
        const ws = new WebSocketServer({ server });
        const port = await listen(server);
        try {
            const result = await new WebsocketChecker(runtime()).run(
                monitor('WEBSOCKET', `ws://example.com:${port}/health`),
            );
            expect(result).toMatchObject({
                success: true,
                meta: { protocol: 'WEBSOCKET', heartbeat: true },
            });
        } finally {
            ws.close();
            await close(server);
        }
    });
    it('times out and terminates when a connected server does not pong', async () => {
        const server = createServer();
        const ws = new WebSocketServer({ server, autoPong: false });
        const port = await listen(server);
        try {
            const result = await new WebsocketChecker(runtime()).run(
                monitor('WEBSOCKET', `ws://example.com:${port}`, {}, 150),
            );
            expect(result).toMatchObject({
                success: false,
                failureKind: 'TIMEOUT',
            });
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(ws.clients.size).toBe(0);
        } finally {
            ws.close();
            await close(server);
        }
    });
    it('does not follow handshake redirects', async () => {
        const server = createServer((_req, res) =>
            res.writeHead(302, { location: 'ws://127.0.0.1:1/secret' }).end(),
        );
        const port = await listen(server);
        try {
            expect(
                await new WebsocketChecker(runtime()).run(
                    monitor('WEBSOCKET', `ws://example.com:${port}`),
                ),
            ).toMatchObject({ success: false, failureKind: 'TRANSPORT' });
        } finally {
            await close(server);
        }
    });
});

describe('Real local standard gRPC health protocol', () => {
    it.each([1, 2, 3, 0])(
        'requires SERVING=1, received status %s',
        async (serving) => {
            const server = new Server();
            const service = (loadPackageDefinition(HEALTH_PACKAGE) as any).grpc
                .health.v1.Health.service;
            const received: string[] = [];
            server.addService(service, {
                check: (call: any, callback: any) => {
                    received.push(call.request.service);
                    callback(null, { status: serving });
                },
            });
            const port = await new Promise<number>((resolve, reject) =>
                server.bindAsync(
                    '127.0.0.1:0',
                    ServerCredentials.createInsecure(),
                    (error, port) => (error ? reject(error) : resolve(port)),
                ),
            );
            try {
                const result = await new GrpcChecker(runtime()).run(
                    monitor('GRPC', `grpc.example.com:${port}`, {
                        tls: false,
                        service: 'example.Service',
                    }),
                );
                expect(result.success).toBe(serving === 1);
                expect(received).toEqual(['example.Service']);
                if (serving !== 1) expect(result.failureKind).toBe('ASSERTION');
            } finally {
                server.forceShutdown();
            }
        },
    );
    it('cancels a hung unary health call by the overall deadline', async () => {
        const server = new Server();
        server.addService(
            (loadPackageDefinition(HEALTH_PACKAGE) as any).grpc.health.v1.Health
                .service,
            { check: () => undefined },
        );
        const port = await new Promise<number>((resolve, reject) =>
            server.bindAsync(
                '127.0.0.1:0',
                ServerCredentials.createInsecure(),
                (error, port) => (error ? reject(error) : resolve(port)),
            ),
        );
        try {
            expect(
                await new GrpcChecker(runtime()).run(
                    monitor(
                        'GRPC',
                        `grpc.example.com:${port}`,
                        { tls: false },
                        150,
                    ),
                ),
            ).toMatchObject({ failureKind: 'TIMEOUT' });
        } finally {
            server.forceShutdown();
        }
    });
});

describe('Real local read-only Docker API transport', () => {
    let server: HttpServer;
    let path: string;
    let requests: string[];
    let response: unknown;
    let statusCode: number;
    let checker: DockerChecker;
    beforeEach(async () => {
        path =
            process.platform === 'win32'
                ? `\\\\.\\pipe\\beacon-docker-${randomUUID()}`
                : join(tmpdir(), `beacon-docker-${randomUUID()}.sock`);
        requests = [];
        statusCode = 200;
        response = {
            State: {
                Status: 'running',
                Running: true,
                StartedAt: '2026-10-10T00:00:00Z',
                Health: { Status: 'healthy' },
            },
            Config: { Env: ['PASSWORD=must-not-leak'] },
        };
        server = createServer((req, res) => {
            requests.push(`${req.method} ${req.url}`);
            res.writeHead(statusCode, {
                'content-type': 'application/json',
            }).end(JSON.stringify(response));
        });
        await new Promise<void>((resolve) => server.listen(path, resolve));
        checker = new DockerChecker(
            runtime(),
            new ConfigService({
                monitor: {
                    dockerSocketPath: path,
                    dockerSocketOrganizationIds: ['org-1'],
                },
            }),
        );
    });
    afterEach(async () => close(server));
    it('only inspects the configured container and persists bounded State metadata', async () => {
        const result = await checker.run(
            monitor('DOCKER', 'unix:///var/run/docker.sock', {
                containerId: 'beacon-api',
            }),
        );
        expect(result).toMatchObject({
            success: true,
            meta: {
                protocol: 'DOCKER',
                containerState: 'running',
                health: 'healthy',
            },
        });
        expect(requests).toEqual([
            'GET /containers/beacon-api/json?size=false',
        ]);
        expect(JSON.stringify(result)).not.toContain('PASSWORD');
    });
    it('does not allow unapproved organizations to access the host socket', async () => {
        const result = await checker.run({
            ...monitor('DOCKER', 'unix:///var/run/docker.sock', {
                containerId: 'beacon-api',
            }),
            organizationId: 'other-org',
        });
        expect(result).toMatchObject({
            evaluated: false,
            failureKind: 'POLICY',
        });
        expect(requests).toEqual([]);
    });
    it.each([
        { Status: 'exited', Running: false },
        { Status: 'paused', Running: true, Paused: true },
        { Status: 'running', Running: true, Health: { Status: 'unhealthy' } },
        { Status: 'running', Running: true, Health: { Status: 'starting' } },
    ])('rejects nonhealthy container state %#', async (state) => {
        response = { State: state };
        expect(
            await checker.run(
                monitor('DOCKER', 'unix:///var/run/docker.sock', {
                    containerId: 'api',
                }),
            ),
        ).toMatchObject({ success: false, failureKind: 'ASSERTION' });
    });
    it('does not follow redirects or log a daemon error body', async () => {
        statusCode = 302;
        response = { message: 'password=must-not-leak' };
        const result = await checker.run(
            monitor('DOCKER', 'unix:///var/run/docker.sock', {
                containerId: 'api',
            }),
        );
        expect(result.success).toBe(false);
        expect(JSON.stringify(result)).not.toContain('must-not-leak');
    });
    it('bounds the inspection response size', async () => {
        response = { State: {}, huge: 'x'.repeat(1024 * 1024 + 1) };
        expect(
            await checker.run(
                monitor('DOCKER', 'unix:///var/run/docker.sock', {
                    containerId: 'api',
                }),
            ),
        ).toMatchObject({ failureKind: 'ASSERTION' });
    });
});
