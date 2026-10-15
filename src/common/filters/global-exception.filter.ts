import {
    ExceptionFilter,
    Catch,
    ArgumentsHost,
    HttpException,
    HttpStatus,
    Logger,
    Optional,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { toIsoString } from '../utils/date.util';
import {
    WechatApiError,
    WechatConfigurationError,
} from '../../infra/wechat/wechat.types';
import { SettingsService } from '../../modules/settings';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(GlobalExceptionFilter.name);

    // 生产路径由 APP_FILTER 注册、稳定注入 SettingsService；
    // 标成可选是为了兼容测试里直接 new GlobalExceptionFilter() 的既有写法。
    constructor(
        @Optional() private readonly settingsService?: SettingsService,
    ) {}

    async catch(exception: unknown, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();

        const wechatError = this.mapWechatError(exception);

        const status =
            exception instanceof HttpException
                ? exception.getStatus()
                : (wechatError?.status ?? HttpStatus.INTERNAL_SERVER_ERROR);

        const rawResponse =
            exception instanceof HttpException
                ? exception.getResponse()
                : (wechatError?.message ?? 'Internal server error');

        const responseBody =
            typeof rawResponse === 'object' && rawResponse !== null
                ? (rawResponse as Record<string, unknown>)
                : undefined;

        // Business exceptions (see BusinessException) opt in to a stable
        // machine-readable `code` next to the message.
        const code =
            typeof responseBody?.code === 'string'
                ? responseBody.code
                : undefined;

        const errorResponse: Record<string, unknown> = {
            statusCode: status,
            ...(code ? { code } : {}),
            timestamp: toIsoString(Date.now()),
            method: request.method,
            message:
                typeof rawResponse === 'string'
                    ? rawResponse
                    : (responseBody?.message ?? rawResponse),
        };

        // develop.debugMode 打开时给 5xx 补一条错误详情，便于测试环境定位
        const detail = await this.debugDetail(exception, status);
        if (detail) errorResponse.detail = detail;

        if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
            this.logger.error(
                `${request.method} ${request.url} ${status}`,
                exception instanceof Error ? exception.stack : undefined,
            );
        } else {
            this.logger.warn(
                `${request.method} ${request.url} ${status} — ${JSON.stringify(errorResponse.message)}`,
            );
        }

        response.status(status).json(errorResponse);
    }

    /**
     * `develop.debugMode` 打开时，为 5xx 响应附上错误详情。
     * 读配置失败（例如数据库不可用）时按「关闭」处理——异常路径上不能再抛异常。
     */
    private async debugDetail(
        exception: unknown,
        status: number,
    ): Promise<string | undefined> {
        if (status < HttpStatus.INTERNAL_SERVER_ERROR) return undefined;
        if (!this.settingsService) return undefined;

        let enabled: boolean;
        try {
            enabled = await this.settingsService.getBoolean(
                'develop.debugMode',
                false,
            );
        } catch {
            return undefined;
        }
        if (!enabled) return undefined;

        if (exception instanceof Error) return exception.message;
        return typeof exception === 'string' ? exception : undefined;
    }

    /**
     * Converts WeChat API/config failures into client-safe HTTP statuses so a
     * bad login code (40029) becomes 400 instead of a generic 500.
     */
    private mapWechatError(exception: unknown): {
        status: number;
        message: string;
    } | null {
        if (exception instanceof WechatConfigurationError) {
            return {
                status: HttpStatus.SERVICE_UNAVAILABLE,
                message: '微信服务未配置或配置无效',
            };
        }

        if (!(exception instanceof WechatApiError)) {
            return null;
        }

        if (exception.isRateLimited || exception.httpStatus === 429) {
            return {
                status: HttpStatus.TOO_MANY_REQUESTS,
                message: '微信接口调用过于频繁，请稍后重试',
            };
        }

        switch (exception.errcode) {
            case 40029:
                return {
                    status: HttpStatus.BAD_REQUEST,
                    message: '微信登录 code 无效或已过期',
                };
            case 40163:
                return {
                    status: HttpStatus.BAD_REQUEST,
                    message: '微信登录 code 已被使用',
                };
            case 40097:
                return {
                    status: HttpStatus.BAD_REQUEST,
                    message: '微信接口参数错误',
                };
            case 40001:
            case 42001:
                return {
                    status: HttpStatus.SERVICE_UNAVAILABLE,
                    message: '微信服务凭证已过期',
                };
            case -1:
                return {
                    status: HttpStatus.SERVICE_UNAVAILABLE,
                    message: '微信服务繁忙，请稍后重试',
                };
            default:
                return {
                    status: HttpStatus.BAD_GATEWAY,
                    message: `微信服务调用失败（errcode ${exception.errcode ?? exception.code ?? '未知'}）`,
                };
        }
    }
}
