import { registerAs } from '@nestjs/config';
import { optionalEnv } from './env';

export interface RedisConfig {
    url: string;
    keyPrefix: string;
}

export const redisConfig = registerAs('redis', (): RedisConfig => ({
    url: optionalEnv('REDIS_URL', 'redis://localhost:6379'),
    keyPrefix: optionalEnv('REDIS_KEY_PREFIX', 'beacon:'),
}));
