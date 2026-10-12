import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
    Optional,
} from '@nestjs/common';
import { RENDER_METADATA } from '@nestjs/common/constants';
import { ClsService } from 'nestjs-cls';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { SKIP_TRANSFORM_KEY } from '../decorators/skip-transform.decorator';
import { toIsoString } from '../utils/date.util';

export interface ApiResponse<T> {
    data: T;
    meta: {
        timestamp: string;
        requestId: string;
    };
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
    T,
    ApiResponse<T>
> {
    constructor(@Optional() private readonly cls?: ClsService) {}

    intercept(
        context: ExecutionContext,
        next: CallHandler,
    ): Observable<ApiResponse<T>> {
        const renderTemplate = Reflect.getMetadata(
            RENDER_METADATA,
            context.getHandler(),
        );

        const skipTransform = Reflect.getMetadata(
            SKIP_TRANSFORM_KEY,
            context.getHandler(),
        );

        if (renderTemplate || skipTransform) {
            return next.handle() as Observable<ApiResponse<T>>;
        }

        const httpContext = context.switchToHttp();

        return next.handle().pipe(
            map((data) => ({
                data,
                meta: {
                    timestamp: toIsoString(Date.now()),
                    requestId:
                        this.cls?.get<string>('requestId') ||
                        httpContext.getRequest().id,
                },
            })),
        );
    }
}
