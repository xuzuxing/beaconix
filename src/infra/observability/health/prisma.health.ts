import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { PrismaService } from '../../database/prisma.service';
import { withTimeout } from '../../../common/utils/with-timeout';

/**
 * Prisma/PostgreSQL 健康检查指示器
 * 用于检测数据库连接状态
 *
 * 说明: 旧的 `HealthIndicator` 基类与 `HealthCheckError` 已在 Terminus v11 标记废弃
 * 并在 v12 移除，因此这里改用 `HealthIndicatorService`，通过 `up()` / `down()`
 * 返回结果，而不是抛异常来表示不健康。
 */
@Injectable()
export class PrismaHealthIndicator {
    constructor(
        private readonly prisma: PrismaService,
        // TerminusModule 提供的 HealthIndicatorService
        private readonly healthIndicatorService: HealthIndicatorService,
    ) {}

    /**
     * 检查 PostgreSQL 数据库是否健康
     * @param key 健康检查的标识键
     * @returns 健康检查结果
     */
    async isHealthy(key: string) {
        const indicator = this.healthIndicatorService.check(key);
        const startTime = Date.now();

        try {
            // 执行简单查询测试连接
            await withTimeout(this.prisma.$queryRaw`SELECT 1`);

            return indicator.up({
                message: 'PostgreSQL is healthy',
                responseTime: `${Date.now() - startTime}ms`,
            });
        } catch {
            return indicator.down({
                message: 'PostgreSQL unavailable',
                responseTime: `${Date.now() - startTime}ms`,
            });
        }
    }
}
