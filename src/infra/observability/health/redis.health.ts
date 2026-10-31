import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { RedisService } from '../../redis/redis.service';
import { withTimeout } from '../../../common/utils/with-timeout';

/**
 * Redis 健康检查指示器
 * 用于检测 Redis 连接状态
 *
 * 说明: 旧的 `HealthIndicator` 基类与 `HealthCheckError` 已在 Terminus v11 标记废弃
 * 并在 v12 移除，因此这里改用 `HealthIndicatorService`，通过 `up()` / `down()`
 * 返回结果，而不是抛异常来表示不健康。
 */
@Injectable()
export class RedisHealthIndicator {
    constructor(
        private readonly redisService: RedisService,
        // TerminusModule 提供的 HealthIndicatorService
        private readonly healthIndicatorService: HealthIndicatorService,
    ) {}

    /**
     * 检查 Redis 是否健康
     * @param key 健康检查的标识键
     * @returns 健康检查结果
     */
    async isHealthy(key: string) {
        const indicator = this.healthIndicatorService.check(key);
        const startTime = Date.now();

        try {
            // 执行 PING 命令测试连接
            const result = await withTimeout(
                this.redisService.getClient().ping(),
            );

            if (result !== 'PONG') {
                return indicator.down({
                    message: 'Redis unavailable',
                    responseTime: `${Date.now() - startTime}ms`,
                });
            }

            return indicator.up({
                message: 'Redis is healthy',
                responseTime: `${Date.now() - startTime}ms`,
            });
        } catch {
            return indicator.down({
                message: 'Redis unavailable',
                responseTime: `${Date.now() - startTime}ms`,
            });
        }
    }
}
