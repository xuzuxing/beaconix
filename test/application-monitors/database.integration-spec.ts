import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import type { MonitorModel } from '../../src/generated/prisma/models';
import { ApplicationCheckRuntime } from '../../src/modules/checker/checkers/application-runtime';
import { MysqlChecker } from '../../src/modules/checker/checkers/mysql.checker';
import { PostgresChecker } from '../../src/modules/checker/checkers/postgres.checker';
import { RedisChecker } from '../../src/modules/checker/checkers/redis.checker';
import { MongodbChecker } from '../../src/modules/checker/checkers/mongodb.checker';

// No .env, connection URI, application datasource or configurable remote host is read.
if (
    process.env.APPLICATION_MONITOR_INTEGRATION !== 'disposable-local-services'
) {
    throw new Error(
        'Refusing database smoke tests without APPLICATION_MONITOR_INTEGRATION=disposable-local-services. Use the isolated CI services, never production databases.',
    );
}

const runtime = new ApplicationCheckRuntime({
    resolve: () => Promise.resolve('127.0.0.1'),
});
const cases = [
    {
        type: 'MYSQL',
        port: 3306,
        checker: new MysqlChecker(runtime),
        config: {
            username: 'monitor_test',
            password: 'monitor_test_password',
            database: 'beacon_monitor_test_ci',
            tls: false,
        },
    },
    {
        type: 'POSTGRESQL',
        port: 5432,
        checker: new PostgresChecker(runtime),
        config: {
            username: 'monitor_test',
            password: 'monitor_test_password',
            database: 'beacon_monitor_test_ci',
            tls: false,
        },
    },
    {
        type: 'REDIS',
        port: 6379,
        checker: new RedisChecker(runtime),
        config: { db: 1, password: 'monitor_test_password', tls: false },
    },
    {
        type: 'MONGODB',
        port: 27017,
        checker: new MongodbChecker(runtime),
        config: {
            username: 'monitor_test',
            password: 'monitor_test_password',
            database: 'admin',
            authSource: 'admin',
            tls: false,
        },
    },
];

for (const entry of cases) {
    void test(`${entry.type} real driver/server health and rejection`, async () => {
        const monitor = {
            type: entry.type,
            target: `db.example.invalid:${entry.port}`,
            config: entry.config,
            timeout: 10000,
        } as unknown as MonitorModel;
        const healthy = await entry.checker.run(monitor);
        assert.equal(healthy.success, true, JSON.stringify(healthy));
        assert.equal(healthy.meta?.protocol, entry.type);
        const rejected = await entry.checker.run({
            ...monitor,
            config: { ...entry.config, password: 'incorrect_fixture_password' },
        });
        assert.equal(rejected.success, false);
        assert.ok(
            !JSON.stringify(rejected).includes('incorrect_fixture_password'),
        );
        if (entry.type === 'REDIS') {
            // CI Redis has two databases. Startup SELECT errors must not be ignored.
            const missingDb = await entry.checker.run({
                ...monitor,
                config: { ...entry.config, db: 15 },
            });
            assert.equal(missingDb.success, false);
        }
    });

    void test(`${entry.type} stalled server respects timeout and closes sockets`, async () => {
        const sockets = new Set<Socket>();
        const server = createServer((socket) => {
            sockets.add(socket);
            socket.on('data', () => undefined);
            socket.on('error', () => undefined);
            socket.on('close', () => sockets.delete(socket));
        });
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
        );
        try {
            const started = Date.now();
            const result = await entry.checker.run({
                type: entry.type,
                target: `db.example.invalid:${(server.address() as AddressInfo).port}`,
                config: entry.config,
                timeout: 400,
            } as unknown as MonitorModel);
            assert.equal(result.success, false);
            assert.ok(Date.now() - started < 2000);
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.equal(
                sockets.size,
                0,
                'driver leaked a socket after deadline',
            );
        } finally {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
}
