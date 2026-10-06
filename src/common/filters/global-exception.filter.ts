import {
    ExceptionFilter,
    Catch,
    ArgumentsHost,
    HttpException,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import {
    WechatApiError,
    WechatConfigurationError,
} from '../../infra/wechat/wechat.types';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(GlobalExceptionFilter.name);

    catch(exception: unknown, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();

        const wechatError = this.mapWechatError(exception);

        const status =
            exception instanceof HttpException
                ? exception.getStatus()
                : (wechatError?.status ?? HttpStatus.INTERNAL_SERVER_ERROR);

        const message =
            exception instanceof HttpException
                ? exception.getResponse()
                : (wechatError?.message ?? 'Internal server error');

        const errorResponse = {
            statusCode: status,
            timestamp: new Date().toISOString(),
            method: request.method,
            message:
                typeof message === 'string'
                    ? message
                    : (message as Record<string, unknown>).message || message,
        };

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
