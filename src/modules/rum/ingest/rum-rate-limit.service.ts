import {
    HttpException,
    HttpStatus,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { RumConfig } from '../../../config';
import { RedisService } from '../../../infra/redis/redis.service';

const WINDOW_SECONDS = 60;
const FIXED_WINDOW_SCRIPT = `
local appCount = redis.call('INCR', KEYS[1])
if appCount == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local sourceCount = redis.call('INCR', KEYS[2])
if sourceCount == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
return { appCount, sourceCount }
`;

@Injectable()
export class RumRateLimitService {
    private readonly config: RumConfig;

    constructor(
        private readonly redis: RedisService,
        configService: ConfigService,
    ) {
        this.config = configService.get<RumConfig>('rum')!;
    }

    async consume(appId: string, source: string): Promise<void> {
        const window = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
        const sourceHash = createHash('sha256')
            .update(source || 'unknown')
            .digest('hex')
            .slice(0, 24);
        let counts: unknown;
        try {
            counts = await this.redis
                .getClient()
                .eval(
                    FIXED_WINDOW_SCRIPT,
                    2,
                    `rum:limit:app:${appId}:${window}`,
                    `rum:limit:source:${appId}:${sourceHash}:${window}`,
                    WINDOW_SECONDS + 5,
                );
        } catch (error) {
            throw new ServiceUnavailableException(
                'RUM ingestion rate limiter unavailable',
                { cause: error },
            );
        }

        const [appCount, sourceCount] = Array.isArray(counts)
            ? counts.map(Number)
            : [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
        if (
            appCount > this.config.appRequestsPerMinute ||
            sourceCount > this.config.sourceRequestsPerMinute
        ) {
            throw new HttpException(
                'RUM ingestion rate limit exceeded',
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }
    }
}
