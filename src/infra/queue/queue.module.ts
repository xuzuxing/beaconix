import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { RedisConfig } from '../../config';

/**
 * BullMQ namespaces its keys as `<prefix>:<queue>`. The app-wide
 * `REDIS_KEY_PREFIX` is reused so queue keys stay in the same namespace as the
 * rest of the application.
 *
 * Note: the prefix must be set here and not through the ioredis `keyPrefix`
 * connection option - BullMQ does not support that option (its Redis
 * connection rejects it) and expects the queue-level `prefix` instead.
 */
export function buildQueuePrefix(keyPrefix: string): string {
    return `${keyPrefix}bull`;
}

/**
 * Registers one queue on the shared connection with the application prefix.
 * Use this instead of `BullModule.registerQueue` so every queue ends up in the
 * same keyspace.
 */
export function registerQueue(name: string): DynamicModule {
    return BullModule.registerQueueAsync({
        name,
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
            prefix: buildQueuePrefix(
                config.get<RedisConfig>('redis')!.keyPrefix,
            ),
        }),
    });
}

/**
 * Owns the shared BullMQ connection (`forRoot`). Feature modules register their
 * own queues with `registerQueue` above and inherit this connection.
 */
@Module({
    imports: [
        BullModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (config: ConfigService) => {
                const redis = config.get<RedisConfig>('redis')!;
                return {
                    connection: {
                        url: redis.url,
                        maxRetriesPerRequest: 3,
                    },
                };
            },
        }),
    ],
})
export class QueueModule {}
