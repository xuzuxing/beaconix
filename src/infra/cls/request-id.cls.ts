import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { ClsService, ClsMiddlewareOptions } from 'nestjs-cls';

/**
 * 请求头 / CLS 上下文关键名常量
 */
export const REQUEST_ID_HEADER = 'x-request-id';
export const CLS_KEY_REQUEST_ID = 'requestId';
export const CLS_KEY_USER = 'user';
export const CLS_KEY_USER_ID = 'userId';
export const CLS_KEY_USER_TYPE = 'userType';
export const CLS_KEY_USERNAME = 'username';
export const CLS_KEY_METHOD = 'method';
export const CLS_KEY_PATH = 'path';
export const CLS_KEY_IP = 'ip';
export const CLS_KEY_USER_AGENT = 'userAgent';
export const CLS_KEY_START_TIME = 'startTime';

function getHeaderValue(value: unknown): string | undefined {
    if (Array.isArray(value)) return value[0];
    return typeof value === 'string' ? value : undefined;
}

function getRequestPath(req: Request): string | undefined {
    const request = req as Request & {
        originalUrl?: string;
        path?: string;
    };
    const url = request.originalUrl || request.url || request.path;
    return url?.split('?')[0];
}

/**
 * 创建统一的 Request ID CLS 中间件配置
 *
 * 提供跨应用一致的请求追踪行为：
 * 1. 从请求头 X-Request-Id 提取已有的 Request ID，否则生成 UUID v4
 * 2. 将 Request ID 写入响应头 X-Request-Id
 * 3. 将 Request ID 写入 CLS 上下文（供日志 / 响应拦截器使用）
 * 4. 若请求上已挂载用户信息（如认证后），则写入 CLS 上下文
 *
 * @example
 * ```ts
 * ClsModule.forRoot({
 *   global: true,
 *   middleware: createRequestIdClsMiddleware(),
 * })
 * ```
 */
export function createRequestIdClsMiddleware(): ClsMiddlewareOptions {
    return {
        mount: true,
        generateId: true,
        idGenerator: (req: Request) => {
            const requestId =
                getHeaderValue(req.headers[REQUEST_ID_HEADER]) || randomUUID();
            req['id'] = requestId;
            req['requestId'] = requestId;
            return requestId;
        },
        setup: (cls: ClsService, req: Request, res: Response) => {
            const requestId = cls.getId();
            res.setHeader('X-Request-Id', requestId);

            cls.set(CLS_KEY_REQUEST_ID, requestId);
            cls.set(CLS_KEY_METHOD, req.method);
            cls.set(CLS_KEY_PATH, getRequestPath(req));
            cls.set(CLS_KEY_IP, req.ip);
            cls.set(CLS_KEY_USER_AGENT, req.headers['user-agent']);
            cls.set(CLS_KEY_START_TIME, Date.now());

            if (req['user']) {
                cls.set(CLS_KEY_USER, req['user']);
            }
        },
    };
}
