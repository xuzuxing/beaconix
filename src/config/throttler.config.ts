import { registerAs } from '@nestjs/config';
import { optionalEnv } from './env';

export interface ThrottlerConfig {
    ttl: number;
    limit: number;
    /** Named `developer` throttler for /api/developer/v1 routes. */
    developerTtl: number;
    developerLimit: number;
}

export const throttlerConfig = registerAs('throttler', (): ThrottlerConfig => ({
    ttl: parseInt(optionalEnv('THROTTLE_TTL', '60'), 10),
    limit: parseInt(optionalEnv('THROTTLE_LIMIT', '10'), 10),
    developerTtl: parseInt(optionalEnv('THROTTLE_DEVELOPER_TTL', '60'), 10),
    developerLimit: parseInt(optionalEnv('THROTTLE_DEVELOPER_LIMIT', '60'), 10),
}));
