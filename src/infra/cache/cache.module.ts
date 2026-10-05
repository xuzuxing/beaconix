import { Global, Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { MultiLevelCacheService } from './multi-level-cache.service';

/**
 * Shared application cache module.
 *
 * Provides a two-level cache:
 * - L1: process-local memory cache via node-cache
 * - L2: shared Redis cache via RedisService
 */
@Global()
@Module({
    imports: [RedisModule],
    providers: [MultiLevelCacheService],
    exports: [MultiLevelCacheService],
})
export class CacheModule {}
