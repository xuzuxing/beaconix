import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { Subject, Observable, finalize } from 'rxjs';
import type Redis from 'ioredis';
import { RedisService } from '../../infra/redis/redis.service';
import { NotificationEntity } from './entities';

export interface NotificationMessageEvent {
    data: NotificationEntity;
    id?: string;
}

@Injectable()
export class NotificationStreamService
    implements OnModuleInit, OnModuleDestroy
{
    private readonly logger = new Logger(NotificationStreamService.name);
    private readonly streams = new Map<
        string,
        Subject<NotificationMessageEvent>
    >();
    private subscriber?: Redis;
    private readonly channel: string;

    constructor(private readonly redis: RedisService) {
        this.channel = `${redis.getClient().options.keyPrefix ?? ''}workspace-notifications`;
    }

    async onModuleInit(): Promise<void> {
        this.subscriber = this.redis
            .getClient()
            .duplicate({ lazyConnect: true });
        this.subscriber.on('error', () => {
            this.logger.warn(
                'Notification stream Redis connection interrupted',
            );
        });
        this.subscriber.on('message', (_channel, message: string) => {
            try {
                const notification = JSON.parse(message) as NotificationEntity;
                if (
                    typeof notification.userId !== 'string' ||
                    typeof notification.id !== 'string'
                )
                    return;
                this.streams.get(notification.userId)?.next({
                    id: notification.id,
                    data: notification,
                });
            } catch {
                this.logger.warn('Invalid notification stream message ignored');
            }
        });
        await this.subscriber.connect();
        await this.subscriber.subscribe(this.channel);
    }

    async onModuleDestroy(): Promise<void> {
        for (const stream of this.streams.values()) stream.complete();
        this.streams.clear();
        await this.subscriber?.quit();
    }

    getStream(userId: string): Observable<NotificationMessageEvent> {
        let subject = this.streams.get(userId);
        if (!subject) {
            subject = new Subject<NotificationMessageEvent>();
            this.streams.set(userId, subject);
        }
        const stream = subject;
        return stream.asObservable().pipe(
            finalize(() => {
                if (!stream.observed && this.streams.get(userId) === stream) {
                    this.streams.delete(userId);
                }
            }),
        );
    }

    async emit(notification: NotificationEntity): Promise<void> {
        await this.redis
            .getClient()
            .publish(this.channel, JSON.stringify(notification));
    }
}
