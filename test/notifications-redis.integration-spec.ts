import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Redis from 'ioredis';
import { firstValueFrom, take, timeout } from 'rxjs';
import { NotificationStreamService } from '../src/modules/notifications/notification-stream.service';
import { NotificationEntity } from '../src/modules/notifications/entities';
import type { RedisService } from '../src/infra/redis/redis.service';
import type { PrismaService } from '../src/infra/database/prisma.service';
import type { NotificationAccessService } from '../src/modules/notifications/notification-access.service';

void test('notification fan-out across two Redis-backed application instances', async () => {
    const value = process.env.NOTIFICATION_TEST_REDIS_URL;
    if (!value)
        throw new Error(
            'Set NOTIFICATION_TEST_REDIS_URL to a local Redis server',
        );
    const url = new URL(value);
    if (
        !['redis:', 'rediss:'].includes(url.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
        throw new Error('Notification Redis test requires a local server');
    }
    const prefix = `notification-test:${randomUUID()}:`;
    const publisherA = new Redis(value, {
        lazyConnect: true,
        keyPrefix: prefix,
    });
    const publisherB = new Redis(value, {
        lazyConnect: true,
        keyPrefix: prefix,
    });
    const notices = new Map<string, NotificationEntity>();
    const prisma = {
        notification: {
            findFirst: ({
                where,
            }: {
                where: { id: string; userId: string };
            }) => {
                const notice = notices.get(where.id);
                return Promise.resolve(
                    notice?.userId === where.userId ? notice : null,
                );
            },
        },
    } as unknown as PrismaService;
    const authorization = {
        visibleWhere: (userId: string) => Promise.resolve({ userId }),
    } as unknown as NotificationAccessService;
    const a = new NotificationStreamService(
        { getClient: () => publisherA } as unknown as RedisService,
        prisma,
        authorization,
    );
    const b = new NotificationStreamService(
        { getClient: () => publisherB } as unknown as RedisService,
        prisma,
        authorization,
    );
    try {
        await publisherA.connect();
        await publisherB.connect();
        await a.onModuleInit();
        await b.onModuleInit();
        const first = firstValueFrom(
            a.getStream('user').pipe(take(1), timeout(5000)),
        );
        const second = firstValueFrom(
            b.getStream('user').pipe(take(1), timeout(5000)),
        );
        const notice = new NotificationEntity({
            id: 'notice',
            userId: 'user',
            type: 'TASK_UPDATED',
        });
        notices.set(notice.id, notice);
        await a.emit(notice);
        assert.equal((await first).id, notice.id);
        assert.equal((await second).id, notice.id);
        const discarded = a.getStream('user').subscribe();
        const retained = firstValueFrom(
            a.getStream('user').pipe(take(1), timeout(5000)),
        );
        discarded.unsubscribe();
        const next = new NotificationEntity({ ...notice, id: 'next' });
        notices.set(next.id, next);
        await b.emit(next);
        assert.equal((await retained).id, 'next');
    } finally {
        await a.onModuleDestroy();
        await b.onModuleDestroy();
        await publisherA.quit();
        await publisherB.quit();
    }
});
