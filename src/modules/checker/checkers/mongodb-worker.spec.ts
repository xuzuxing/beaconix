import { Worker } from 'node:worker_threads';
import type { MonitorModel } from '../../../generated/prisma/models';
import { MongodbChecker } from './mongodb.checker';
import { ApplicationCheckRuntime } from './application-runtime';

jest.mock('node:worker_threads', () => {
    const actual = jest.requireActual<typeof import('node:worker_threads')>(
        'node:worker_threads',
    );
    return {
        ...actual,
        Worker: jest.fn(
            (script, options) =>
                new actual.Worker(script, {
                    ...options,
                    workerData: {
                        ...options.workerData,
                        driver: require.resolve('./fixtures/mongo-worker-driver.fixture.cjs'),
                    },
                }),
        ),
    };
});

describe('Real MongoDB worker lifecycle', () => {
    const checker = () =>
        new MongodbChecker(
            new ApplicationCheckRuntime({
                resolve: () => Promise.resolve('127.0.0.1'),
            }),
        );
    const monitor = (username: string) =>
        ({
            type: 'MONGODB',
            target: 'mongo.example.com:27017',
            timeout: 500,
            config: { username, password: 'private-password', tls: false },
        }) as unknown as MonitorModel;
    beforeEach(() => jest.clearAllMocks());
    it.each(['healthy', 'assertion', 'fail'])(
        'runs the worker protocol and closes before returning: %s',
        async (username) => {
            const result = await checker().run(monitor(username));
            expect(result.success).toBe(username === 'healthy');
            if (username === 'assertion')
                expect(result.failureKind).toBe('ASSERTION');
            expect(JSON.stringify(result)).not.toContain('private-password');
        },
    );
    it.each(['hang-connect', 'hang-close'])(
        'terminates hung %s resources within the check budget',
        async (username) => {
            const start = Date.now();
            const result = await checker().run(monitor(username));
            expect(result.failureKind).toBe('TIMEOUT');
            const worker = (Worker as unknown as jest.Mock).mock.results[0]
                .value as Worker;
            await new Promise<void>((resolve) => {
                if (worker.threadId === -1) resolve();
                else worker.once('exit', () => resolve());
            });
            expect(worker.threadId).toBe(-1);
            expect(Date.now() - start).toBeLessThan(2000);
        },
    );
});
