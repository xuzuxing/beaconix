import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { MetricsService } from './metrics.service';

/**
 * 判断路径是否属于监控自身端点（/metrics、/health），这些请求不记录 HTTP 指标。
 *
 * 需要容忍 `setGlobalPrefix('api')`：控制器路由与模块中间件拿到的都是带前缀的
 * 完整路径（如 `/api/health/ready`、`/api/metrics`），只匹配 `^/health` 会漏掉。
 */
export function skipHttpMetrics(path: string): boolean {
    return /^\/(?:api\/)?(?:metrics|health)(?:\/|$)/.test(path.split('?')[0]);
}

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
    constructor(private readonly metrics: MetricsService) {}

    use(request: Request, response: Response, next: NextFunction): void {
        response.locals.omniMetricsStarted = true;
        if (skipHttpMetrics(request.originalUrl)) return next();
        const startedAt = process.hrtime.bigint();
        const method = [
            'GET',
            'POST',
            'PUT',
            'PATCH',
            'DELETE',
            'HEAD',
            'OPTIONS',
        ].includes(request.method)
            ? request.method
            : 'OTHER';
        // Routes are not resolved before guards run; in-flight is aggregate per method.
        const stop = this.metrics.startHttpRequest(method, 'all');
        let recorded = false;
        const finish = () => {
            if (recorded) return;
            recorded = true;
            response.removeListener('finish', finish);
            response.removeListener('close', finish);
            stop();
            const route = request.route?.path;
            const path = typeof route === 'string' ? route : 'unmatched';
            if (skipHttpMetrics(path)) return;
            this.metrics.recordHttpRequest(
                method,
                path,
                response.writableFinished ? response.statusCode : 499,
                Number(process.hrtime.bigint() - startedAt) / 1e9,
            );
        };
        response.once('finish', finish);
        response.once('close', finish);
        next();
    }
}
