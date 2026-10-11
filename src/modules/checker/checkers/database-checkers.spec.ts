import * as net from 'node:net';
import { createConnection } from 'mysql2';
import { Client } from 'pg';
import Redis from 'ioredis';
import { Worker } from 'node:worker_threads';
import type { MonitorModel } from '../../../generated/prisma/models';
import { MysqlChecker } from './mysql.checker';
import { PostgresChecker } from './postgres.checker';
import { RedisChecker } from './redis.checker';
import { MongodbChecker } from './mongodb.checker';
import { ApplicationCheckRuntime } from './application-runtime';

jest.mock('mysql2', () => ({ createConnection: jest.fn(() => mockMysql) }));
jest.mock('pg', () => ({ Client: jest.fn(() => mockPostgres) }));
jest.mock('ioredis', () => ({
    __esModule: true,
    default: jest.fn(() => mockRedis),
}));
jest.mock('node:worker_threads', () => {
    const { EventEmitter } =
        jest.requireActual<typeof import('node:events')>('node:events');
    return {
        Worker: jest.fn(() => {
            const worker = new EventEmitter() as any;
            worker.terminate = jest.fn().mockResolvedValue(0);
            setImmediate(() => {
                worker.emit('message', mockMongoOutcome);
                worker.emit('exit', 0);
            });
            return worker;
        }),
    };
});
jest.mock('node:net', () => {
    const actual = jest.requireActual<typeof import('node:net')>('node:net');
    return { ...actual, createConnection: jest.fn(() => new actual.Socket()) };
});

const mockQuery = jest.fn();
const mockMysql = {
    on: jest.fn(),
    destroy: jest.fn(),
    promise: () => ({ query: mockQuery }),
};
const mockPostgres = {
    on: jest.fn(),
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
};
const mockRedis = {
    on: jest.fn(),
    connect: jest.fn(),
    select: jest.fn(),
    auth: jest.fn(),
    ping: jest.fn(),
    disconnect: jest.fn(),
};
let mockMongoOutcome = { ok: true, assertion: false };

const config = {
    username: 'monitor',
    password: 'private-secret',
    database: 'health',
    tls: true,
};
const monitor = (type: string, nextConfig: object = config) =>
    ({
        type,
        target: 'db.example.com:1234',
        config: nextConfig,
        timeout: 200,
    }) as unknown as MonitorModel;
const runtime = () =>
    new ApplicationCheckRuntime({
        resolve: jest.fn().mockResolvedValue('1.1.1.1'),
    });

describe('Application database checkers', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockQuery.mockResolvedValue([[{ beacon_health: 1 }], []]);
        mockPostgres.connect.mockResolvedValue(undefined);
        mockPostgres.query.mockResolvedValue({ rows: [{ beacon_health: 1 }] });
        mockRedis.connect.mockResolvedValue(undefined);
        mockRedis.ping.mockResolvedValue('PONG');
        mockRedis.select.mockResolvedValue('OK');
        mockRedis.auth.mockResolvedValue('OK');
        mockMongoOutcome = { ok: true, assertion: false };
    });
    afterEach(() => jest.restoreAllMocks());

    it('executes a fixed MySQL query over the pinned stream and destroys the connection', async () => {
        const result = await new MysqlChecker(runtime()).run(monitor('MYSQL'));
        expect(result).toMatchObject({
            success: true,
            meta: { protocol: 'MYSQL', operation: 'SELECT 1' },
        });
        expect(net.createConnection).toHaveBeenCalledWith({
            host: '1.1.1.1',
            port: 1234,
        });
        expect(createConnection).toHaveBeenCalledWith(
            expect.objectContaining({
                host: 'db.example.com',
                password: 'private-secret',
                multipleStatements: false,
                flags: ['-LOCAL_FILES'],
                ssl: {
                    ca: undefined,
                    rejectUnauthorized: true,
                    verifyIdentity: true,
                },
            }),
        );
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ sql: 'SELECT 1 AS beacon_health' }),
        );
        expect(mockMysql.destroy).toHaveBeenCalledTimes(1);
    });
    it('executes a fixed PostgreSQL query with TLS identity distinct from pinned address', async () => {
        const result = await new PostgresChecker(runtime()).run(
            monitor('POSTGRESQL'),
        );
        expect(result.success).toBe(true);
        expect(Client).toHaveBeenCalledWith(
            expect.objectContaining({
                host: '1.1.1.1',
                user: 'monitor',
                database: 'health',
                ssl: {
                    servername: 'db.example.com',
                    ca: undefined,
                    rejectUnauthorized: true,
                },
            }),
        );
        expect(mockPostgres.query).toHaveBeenCalledWith(
            'SELECT 1 AS beacon_health',
        );
        expect(mockPostgres.end).toHaveBeenCalledTimes(1);
    });
    it('validates Redis PONG and disables reconnection', async () => {
        const result = await new RedisChecker(runtime()).run(
            monitor('REDIS', { password: 'private-secret' }),
        );
        expect(result.success).toBe(true);
        expect(Redis).toHaveBeenCalledWith(
            expect.objectContaining({
                host: '1.1.1.1',
                lazyConnect: true,
                maxRetriesPerRequest: 0,
                enableOfflineQueue: false,
                tls: {
                    servername: 'db.example.com',
                    ca: undefined,
                    rejectUnauthorized: true,
                },
            }),
        );
        expect(mockRedis.ping).toHaveBeenCalledTimes(1);
        expect(mockRedis.disconnect).toHaveBeenCalledWith(false);
    });
    it('uses MongoDB direct connection and pinned lookup without connection-string credentials', async () => {
        const result = await new MongodbChecker(runtime()).run(
            monitor('MONGODB'),
        );
        expect(result.success).toBe(true);
        expect(Worker).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                eval: true,
                workerData: expect.objectContaining({
                    address: '1.1.1.1',
                    url: 'mongodb://db.example.com:1234',
                    config: expect.objectContaining({
                        password: 'private-secret',
                    }),
                }),
            }),
        );
    });
    it.each(['MYSQL', 'POSTGRESQL', 'REDIS', 'MONGODB'])(
        'sanitizes %s errors and still closes connections',
        async (type) => {
            mockQuery.mockRejectedValue(new Error('password=private-secret'));
            mockPostgres.query.mockRejectedValue(
                new Error('password=private-secret'),
            );
            mockRedis.ping.mockRejectedValue(
                new Error('password=private-secret'),
            );
            mockMongoOutcome = { ok: false, assertion: false };
            const checkers = {
                MYSQL: new MysqlChecker(runtime()),
                POSTGRESQL: new PostgresChecker(runtime()),
                REDIS: new RedisChecker(runtime()),
                MONGODB: new MongodbChecker(runtime()),
            };
            const result = await checkers[type].run(
                monitor(type, type === 'REDIS' ? {} : config),
            );
            expect(result).toMatchObject({
                success: false,
                failureKind: 'TRANSPORT',
                error: 'Application protocol check failed',
            });
            expect(JSON.stringify(result)).not.toContain('private-secret');
        },
    );
    it.each(['MYSQL', 'POSTGRESQL', 'REDIS', 'MONGODB'])(
        'rejects unexpected %s health results',
        async (type) => {
            mockQuery.mockResolvedValue([[{ beacon_health: 0 }], []]);
            mockPostgres.query.mockResolvedValue({
                rows: [{ beacon_health: 0 }],
            });
            mockRedis.ping.mockResolvedValue('BAD');
            mockMongoOutcome = { ok: false, assertion: true };
            const checkers = {
                MYSQL: new MysqlChecker(runtime()),
                POSTGRESQL: new PostgresChecker(runtime()),
                REDIS: new RedisChecker(runtime()),
                MONGODB: new MongodbChecker(runtime()),
            };
            const result = await checkers[type].run(
                monitor(type, type === 'REDIS' ? {} : config),
            );
            expect(result).toMatchObject({
                success: false,
                failureKind: 'ASSERTION',
            });
        },
    );
    it.each(['POSTGRESQL', 'REDIS'])(
        'does not send %s commands after a late connection',
        async (type) => {
            const connect = () =>
                new Promise((resolve) => setTimeout(resolve, 240));
            mockPostgres.connect.mockImplementation(connect);
            mockRedis.connect.mockImplementation(connect);
            const checkers = {
                POSTGRESQL: new PostgresChecker(runtime()),
                REDIS: new RedisChecker(runtime()),
                MONGODB: new MongodbChecker(runtime()),
            };
            expect(
                await checkers[type].run(
                    monitor(type, type === 'REDIS' ? {} : config),
                ),
            ).toMatchObject({ failureKind: 'TIMEOUT' });
            await new Promise((resolve) => setTimeout(resolve, 60));
            expect(mockPostgres.query).not.toHaveBeenCalled();
            expect(mockRedis.ping).not.toHaveBeenCalled();
        },
    );
    it('rejects Redis SELECT failures even when PING could succeed', async () => {
        mockRedis.select.mockRejectedValue(
            new Error('ERR DB index is out of range'),
        );
        expect(
            await new RedisChecker(runtime()).run(monitor('REDIS', { db: 15 })),
        ).toMatchObject({ success: false });
        expect(mockRedis.ping).not.toHaveBeenCalled();
    });
    it('does not ignore AUTH failures from a server with no password configured', async () => {
        mockRedis.auth.mockRejectedValue(
            new Error('ERR AUTH without any password configured'),
        );
        expect(
            await new RedisChecker(runtime()).run(
                monitor('REDIS', { password: 'private-secret' }),
            ),
        ).toMatchObject({ success: false });
        expect(mockRedis.ping).not.toHaveBeenCalled();
    });
    it('passes an explicit PostgreSQL password callback even for an empty password', async () => {
        await new PostgresChecker(runtime()).run(
            monitor('POSTGRESQL', { username: 'u', database: 'd' }),
        );
        const options = (Client as jest.Mock).mock.calls[0][0];
        expect(typeof options.password).toBe('function');
        expect(options.password()).toBe('');
    });
});
