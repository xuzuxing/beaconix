import {
    BadRequestException,
    CallHandler,
    ExecutionContext,
    Injectable,
    NestInterceptor,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { map } from 'rxjs/operators';
import type { Observable } from 'rxjs';

export function weakEtag(body: unknown) {
    return `W/"${createHash('sha256').update(JSON.stringify(body)).digest('hex')}"`;
}

export function etagMatches(header: string | undefined, etag: string) {
    return !!header
        ?.split(',')
        .some(
            (token) =>
                token.trim() === '*' ||
                token.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''),
        );
}

@Injectable()
export class MonitoringEtagInterceptor implements NestInterceptor {
    intercept(
        context: ExecutionContext,
        next: CallHandler,
    ): Observable<unknown> {
        const request = context.switchToHttp().getRequest<Request>();
        const response = context.switchToHttp().getResponse<Response>();
        const endpoint = request.path.split('/').at(-1);
        const allowed =
            endpoint === 'dashboard'
                ? ['tz', 'range', 'slowLimit', 'alertLimit']
                : endpoint === 'availability'
                  ? ['tz', 'days']
                  : ['tz', 'hours'];
        if (
            Object.entries(request.query).some(
                ([key, value]) =>
                    !allowed.includes(key) ||
                    typeof value !== 'string' ||
                    !value,
            )
        ) {
            throw new BadRequestException(
                'Unknown, empty or repeated query parameter',
            );
        }
        return next.handle().pipe(
            map((body: unknown) => {
                const tag = weakEtag(body);
                response.setHeader('ETag', tag);
                response.setHeader('Cache-Control', 'private, no-cache');
                if (etagMatches(request.headers['if-none-match'], tag)) {
                    response.status(304);
                    return undefined;
                }
                return {
                    data: body,
                    meta: {
                        timestamp: new Date().toISOString(),
                        requestId: request.id,
                    },
                };
            }),
        );
    }
}
