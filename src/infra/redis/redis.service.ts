import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { RedisConfig } from '../../config';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(RedisService.name);
    private readonly client: Redis;

    constructor(private readonly configService: ConfigService) {
        const redis = this.configService.get<RedisConfig>('redis')!;

        this.client = new Redis(redis.url, {
            keyPrefix: redis.keyPrefix,
            lazyConnect: true,
            maxRetriesPerRequest: 3,
        });

        this.client.on('error', (error) => {
            this.logger.error(`Redis error: ${error.message}`);
        });
    }

    async onModuleInit(): Promise<void> {
        this.logger.log('Connecting to Redis...');
        await this.client.connect();
        await this.ping();
        this.logger.log('Successfully connected to Redis');
    }

    async onModuleDestroy(): Promise<void> {
        this.logger.log('Disconnecting from Redis...');
        await this.client.quit();
        this.logger.log('Successfully disconnected from Redis');
    }

    /** Returns the raw ioredis client for advanced operations not wrapped here. */
    getClient(): Redis {
        return this.client;
    }

    /** Clears the selected Redis database; use only in tests or maintenance tasks. */
    async reset(): Promise<void> {
        await this.client.flushall();
    }

    /** Checks whether Redis is reachable and returns its PONG response. */
    async ping(): Promise<string> {
        return this.client.ping();
    }

    /** Reads a raw string value by key, returning null when the key is missing. */
    async get(key: string): Promise<string | null> {
        return this.client.get(key);
    }

    /** Writes a raw string value, optionally applying an expiry in seconds. */
    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
        if (ttlSeconds === undefined) {
            await this.client.set(key, value);
            return;
        }

        await this.client.set(key, value, 'EX', ttlSeconds);
    }

    /** Reads and parses a JSON value, returning null when the key is missing. */
    async getJson<T>(key: string): Promise<T | null> {
        const raw = await this.get(key);
        if (!raw) return null;

        return JSON.parse(raw) as T;
    }

    /** Serializes and writes a JSON value, optionally applying an expiry in seconds. */
    async setJson<T>(
        key: string,
        value: T,
        ttlSeconds?: number,
    ): Promise<void> {
        await this.set(key, JSON.stringify(value), ttlSeconds);
    }

    /** Deletes one or more keys. Missing keys are ignored by Redis. */
    async del(...keys: string[]): Promise<void> {
        await this.client.del(keys);
    }

    /** Updates the expiry of an existing key in seconds. */
    async expire(key: string, ttlSeconds: number): Promise<void> {
        await this.client.expire(key, ttlSeconds);
    }

    /**
     * Sets a key only when it does not exist yet, returning false when someone
     * else got there first. Used for short-lived distributed locks.
     */
    async setIfAbsent(
        key: string,
        value: string,
        ttlSeconds: number,
    ): Promise<boolean> {
        const result = await this.client.set(
            key,
            value,
            'EX',
            ttlSeconds,
            'NX',
        );

        return result === 'OK';
    }

    /**
     * Releases a lock only while `value` still owns it, so a lock that already
     * expired and was taken over by another holder is left untouched.
     */
    async releaseLock(key: string, value: string): Promise<boolean> {
        const released = await this.client.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            key,
            value,
        );

        return Number(released) === 1;
    }
}
