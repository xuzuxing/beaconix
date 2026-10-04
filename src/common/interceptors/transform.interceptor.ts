import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
} from '@nestjs/common';
import { RENDER_METADATA } from '@nestjs/common/constants';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResponse<T> {
    data: T;
    meta: {
        timestamp: string;
    };
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
    T,
    ApiResponse<T>
> {
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

        return next.handle().pipe(
            map((data) => ({
                data,
                meta: {
                    timestamp: new Date().toISOString(),
                },
            })),
        );
    }
}
