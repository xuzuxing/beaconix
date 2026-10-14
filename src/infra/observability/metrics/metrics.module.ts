import {
    Global,
    MiddlewareConsumer,
    Module,
    NestModule,
    RequestMethod,
} from '@nestjs/common';
import { METRICS_RECORDER } from './metrics.constants';

import { MetricsMiddleware } from './metrics.middleware';
import { MetricsService } from './metrics.service';
import { HttpMetricsMiddleware } from './http-metrics.middleware';

/**
 * 指标收集模块
 *
 * @description 提供 Prometheus 指标收集服务
 * 全局模块，可在任何地方注入 MetricsService
 *
 * 说明: HTTP 请求指标统一由 HttpMetricsMiddleware 负责（覆盖全部路由），
 * MetricsInterceptor 未在此注册，避免与中间件重复计数。
 */
@Global()
@Module({
    providers: [
        MetricsService,
        MetricsMiddleware,
        HttpMetricsMiddleware,
        { provide: METRICS_RECORDER, useExisting: MetricsService },
    ],
    exports: [MetricsService, METRICS_RECORDER],
})
export class MetricsModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        consumer
            .apply(HttpMetricsMiddleware)
            .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
        consumer
            .apply(MetricsMiddleware)
            .forRoutes({ path: 'metrics', method: RequestMethod.GET });
    }
}
