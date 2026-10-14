import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { finalize, tap } from 'rxjs/operators';
import { MetricsService } from './metrics.service';
import { Request, Response } from 'express';
import { skipHttpMetrics } from './http-metrics.middleware';

/**
 * HTTP 请求指标收集拦截器
 *
 * @description 自动收集 HTTP 请求的计数和延迟指标
 * 实现需求 2.3
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
    constructor(private readonly metricsService: MetricsService) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const ctx = context.switchToHttp();
        const request = ctx.getRequest<Request>();
        const response = ctx.getResponse<Response>();
        if (response.locals?.omniMetricsStarted) return next.handle();

        const startTime = process.hrtime.bigint();
        const method = request.method;
        const path = request.route?.path || request.path || request.url;
        let statusCode = response.statusCode;

        if (this.shouldSkip(path)) {
            return next.handle();
        }

        const finishRequest = this.metricsService.startHttpRequest(
            method,
            path,
        );

        return next.handle().pipe(
            tap({
                next: () => {
                    statusCode = response.statusCode;
                },
                error: (error) => {
                    statusCode = error.status || error.statusCode || 500;
                },
            }),
            finalize(() => {
                finishRequest();
                this.recordMetrics(method, path, statusCode, startTime);
            }),
        );
    }

    /**
     * 记录请求指标
     */
    private recordMetrics(
        method: string,
        path: string,
        statusCode: number,
        startTime: bigint,
    ): void {
        // 计算请求耗时（秒）
        const endTime = process.hrtime.bigint();
        const durationNs = Number(endTime - startTime);
        const durationSeconds = durationNs / 1e9;

        // 记录 HTTP 请求指标
        this.metricsService.recordHttpRequest(
            method,
            path,
            statusCode,
            durationSeconds,
        );
    }

    private shouldSkip(path: string): boolean {
        return skipHttpMetrics(path);
    }
}
