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

        if (renderTemplate) {
            return next.handle() as Observable<ApiResponse<T>>;
        }

        const httpContext = context.switchToHttp();

        return next.handle().pipe(
            map((data) => ({
                data,
                meta: {
                    timestamp: new Date().toISOString(),
                    requestId:
                        this.cls?.get<string>('requestId') ||
                        httpContext.getRequest().id,
                },
            })),
        );
    }
}
