import {
    BadRequestException,
    CallHandler,
    ExecutionContext,
    Injectable,
    NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { map } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { toIsoString } from '../../common/utils/date.util';
import {
    etagMatches,
    weakEtag,
} from '../monitoring/monitoring-etag.interceptor';

/**
 * Query validation plus conditional responses for the anonymous status page.
 *
 * The endpoint takes a single optional `tz` parameter, so anything repeated,
 * empty or unknown is rejected instead of being silently ignored. The response
 * is wrapped here (the handler is marked `@SkipTransform`) because the entity
 * tag must cover exactly the payload that is sent back: `meta.timestamp`
 * changes on every request and cannot take part in the hash.
 *
 * Nothing about the caller identifies the payload - the page is public - so the
 * tag is a pure hash of the body and `Cache-Control` stays revalidating: a
 * visitor pressing refresh must reach the service, not a stale browser copy.
 */
@Injectable()
export class PublicStatusEtagInterceptor implements NestInterceptor {
    private static readonly ALLOWED_QUERY = ['tz'];

    intercept(
        context: ExecutionContext,
        next: CallHandler,
    ): Observable<unknown> {
        const request = context.switchToHttp().getRequest<Request>();
        const response = context.switchToHttp().getResponse<Response>();

        if (
            Object.entries(request.query).some(
                ([key, value]) =>
                    !PublicStatusEtagInterceptor.ALLOWED_QUERY.includes(key) ||
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
                response.setHeader('Cache-Control', 'public, no-cache');
                if (etagMatches(request.headers['if-none-match'], tag)) {
                    response.status(304);
                    return undefined;
                }
                return {
                    data: body,
                    meta: {
                        timestamp: toIsoString(Date.now()),
                        requestId: request.id,
                    },
                };
            }),
        );
    }
}
