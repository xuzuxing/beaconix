import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { MonitorType } from '../../../generated/prisma/enums';
import type { MonitorModel } from '../../../generated/prisma/models';
import type { CheckerStrategy } from './checker.interface';
import {
    ApplicationCheckError,
    ApplicationCheckRuntime,
} from './application-runtime';

@Injectable()
export class RedisChecker implements CheckerStrategy {
    readonly type = MonitorType.REDIS;
    constructor(private readonly runtime: ApplicationCheckRuntime) {}

    run(monitor: MonitorModel) {
        return this.runtime.run(monitor, async (context) => {
            const { config, host, port, address } = context;
            const client = new Redis({
                host: address,
                port,
                db: 0,
                lazyConnect: true,
                tls: config.tls
                    ? {
                          servername: host,
                          ca: config.tlsCa,
                          rejectUnauthorized: true,
                      }
                    : undefined,
                connectTimeout: context.remaining(),
                commandTimeout: context.remaining(),
                maxRetriesPerRequest: 0,
                retryStrategy: () => null,
                reconnectOnError: () => false,
                enableOfflineQueue: false,
                enableReadyCheck: false,
                disableClientInfo: true,
                disconnectTimeout: 1,
            });
            client.on('error', () => undefined);
            context.cleanup(() => {
                client.disconnect(false);
                client.stream?.destroy();
            });
            await client.connect();
            context.signal.throwIfAborted();
            // Startup AUTH errors can be tolerated by ioredis; explicitly verify credentials.
            if (config.password !== undefined) {
                const authenticated = config.username
                    ? await client.auth(config.username, config.password)
                    : await client.auth(config.password);
                if (authenticated !== 'OK') {
                    throw new ApplicationCheckError(
                        'ASSERTION',
                        'Redis authentication failed',
                    );
                }
                context.signal.throwIfAborted();
            }
            if ((await client.select(config.db ?? 0)) !== 'OK') {
                throw new ApplicationCheckError(
                    'ASSERTION',
                    'Redis database selection failed',
                );
            }
            context.signal.throwIfAborted();
            if ((await client.ping()) !== 'PONG') {
                throw new ApplicationCheckError(
                    'ASSERTION',
                    'Redis PING returned an unexpected result',
                );
            }
            return { protocol: 'REDIS', operation: 'PING' };
        });
    }
}
