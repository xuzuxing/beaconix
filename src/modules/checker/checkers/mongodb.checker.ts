import { Injectable } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { MonitorType } from '../../../generated/prisma/enums';
import type { MonitorModel } from '../../../generated/prisma/models';
import type { CheckerStrategy } from './checker.interface';
import {
    ApplicationCheckError,
    ApplicationCheckRuntime,
} from './application-runtime';

// Driver close() may open connections for endSessions without an abort signal.
// A dedicated worker makes the entire driver lifecycle forcibly cancellable.
export const MONGODB_WORKER = `
const { parentPort, workerData: data } = require('node:worker_threads');
const { isIP } = require('node:net');
const { MongoClient } = require(data.driver);
const client = new MongoClient(data.url, {
    auth: data.config.username ? { username: data.config.username, password: data.config.password ?? '' } : undefined,
    authSource: data.config.authSource,
    directConnection: true, retryReads: false, retryWrites: false,
    maxPoolSize: 1, minPoolSize: 0,
    serverSelectionTimeoutMS: data.timeout, connectTimeoutMS: data.timeout,
    socketTimeoutMS: data.timeout, timeoutMS: data.timeout,
    tls: data.config.tls, ca: data.config.tlsCa,
    autoSelectFamily: false,
    lookup: (_host, options, callback) => {
        if (options?.all) callback(null, [{ address: data.address, family: isIP(data.address) }]);
        else callback(null, data.address, isIP(data.address));
    },
});
(async () => {
    let outcome;
    try {
        await client.connect();
        const result = await client.db(data.config.database).command(
            { ping: 1 }, { signal: AbortSignal.timeout(data.timeout) },
        );
        outcome = { ok: result.ok === 1, assertion: result.ok !== 1 };
    } catch { outcome = { ok: false, assertion: false }; }
    finally { await client.close(); }
    parentPort.postMessage(outcome);
})().catch(() => { parentPort.postMessage({ ok: false, assertion: false }); });
`;

@Injectable()
export class MongodbChecker implements CheckerStrategy {
    readonly type = MonitorType.MONGODB;
    constructor(private readonly runtime: ApplicationCheckRuntime) {}

    run(monitor: MonitorModel) {
        return this.runtime.run(
            monitor,
            (context) =>
                new Promise((resolve, reject) => {
                    const hostname = context.host.includes(':')
                        ? `[${context.host}]`
                        : context.host;
                    const worker = new Worker(MONGODB_WORKER, {
                        eval: true,
                        workerData: {
                            driver: require.resolve('mongodb'),
                            url: `mongodb://${hostname}:${context.port}`,
                            address: context.address,
                            config: context.config,
                            timeout: context.remaining(),
                        },
                        stdout: true,
                        stderr: true,
                    });
                    // Do not forward driver diagnostics, including DEBUG environment output.
                    worker.stdout?.resume();
                    worker.stderr?.resume();
                    context.cleanup(() => {
                        void worker.terminate().catch(() => undefined);
                    });
                    let outcome:
                        { ok: boolean; assertion: boolean } | undefined;
                    worker.on('message', (value) => {
                        outcome = value;
                    });
                    worker.once('error', () =>
                        reject(new Error('MongoDB worker failed')),
                    );
                    worker.once('exit', (code) => {
                        if (code === 0 && outcome?.ok)
                            resolve({ protocol: 'MONGODB', operation: 'PING' });
                        else if (outcome?.assertion)
                            reject(
                                new ApplicationCheckError(
                                    'ASSERTION',
                                    'MongoDB PING returned an unexpected result',
                                ),
                            );
                        else reject(new Error('MongoDB protocol check failed'));
                    });
                }),
        );
    }
}
