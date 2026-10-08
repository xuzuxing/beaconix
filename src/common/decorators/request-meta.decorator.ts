import { createParamDecorator } from '@nestjs/common';
import { Request } from 'express';
import type { RequestMeta as RequestMetaShape } from '../interfaces/request-meta.interface';

/**
 * Extracts the client IP + User-Agent from an Express request. Shares the
 * `x-forwarded-for` handling with the audit interceptor so both agree on the
 * caller's address behind a proxy.
 */
export function extractRequestMeta(request: Request): RequestMetaShape {
    const forwarded = request.headers['x-forwarded-for'];
    const ipAddress =
        typeof forwarded === 'string'
            ? (forwarded.split(',')[0]?.trim() ?? null)
            : (request.ip ?? null);
    const userAgent = (request.headers['user-agent'] as string) ?? null;

    return { ipAddress, userAgent };
}

/**
 * Binds the request metadata (IP + User-Agent) to a handler parameter.
 *
 * Usage: `async login(@Body() dto: LoginDto, @RequestMeta() meta: RequestMeta)`.
 */
export const RequestMeta = createParamDecorator<unknown, RequestMetaShape>(
    (_data, ctx): RequestMetaShape => {
        const request = ctx.switchToHttp().getRequest<Request>();
        return extractRequestMeta(request);
    },
);
