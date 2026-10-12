import { Injectable, Logger, Optional, Scope } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { toIsoString } from '../../common/utils/date.util';
import {
    CLS_KEY_IP,
    CLS_KEY_METHOD,
    CLS_KEY_PATH,
    CLS_KEY_REQUEST_ID,
    CLS_KEY_USER_AGENT,
    CLS_KEY_USER_ID,
    CLS_KEY_USER_TYPE,
    CLS_KEY_USERNAME,
} from '../cls/request-id.cls';

export interface LogContext {
    action?: string;
    event?: string;
    module?: string;
    userId?: string;
    userType?: string;
    username?: string;
    requestId?: string;
    method?: string;
    path?: string;
    ip?: string;
    userAgent?: string;
    [key: string]: unknown;
}

@Injectable({ scope: Scope.TRANSIENT })
export class StructuredLoggerService {
    private logger: Logger;

    constructor(@Optional() private readonly cls?: ClsService) {
        this.logger = new Logger('Application');
    }

    setContext(context: string): void {
        this.logger = new Logger(context);
    }

    private getRequestContext(): Partial<LogContext> {
        try {
            return {
                requestId: this.cls?.get(CLS_KEY_REQUEST_ID),
                userId: this.cls?.get(CLS_KEY_USER_ID),
                userType: this.cls?.get(CLS_KEY_USER_TYPE),
                username: this.cls?.get(CLS_KEY_USERNAME),
                method: this.cls?.get(CLS_KEY_METHOD),
                path: this.cls?.get(CLS_KEY_PATH),
                ip: this.cls?.get(CLS_KEY_IP),
                userAgent: this.cls?.get(CLS_KEY_USER_AGENT),
            };
        } catch {
            return {};
        }
    }

    private buildContext(context?: LogContext): LogContext {
        return {
            ...this.getRequestContext(),
            ...context,
            timestamp: toIsoString(Date.now()),
        };
    }

    error(message: string | Error, context?: LogContext): void {
        const ctx = this.buildContext(context);

        if (message instanceof Error) {
            this.logger.error({
                ...ctx,
                error: message.message,
                stack: message.stack?.split('\n').slice(0, 10),
            });
            return;
        }

        this.logger.error({ ...ctx, message });
    }

    warn(message: string, context?: LogContext): void {
        this.logger.warn({ ...this.buildContext(context), message });
    }

    info(context: LogContext & { action: string }): void {
        this.logger.log(this.buildContext(context));
    }

    debug(message: string, context?: LogContext): void {
        this.logger.debug({ ...this.buildContext(context), message });
    }

    verbose(message: string, context?: LogContext): void {
        this.logger.verbose({ ...this.buildContext(context), message });
    }

    logOperation(
        action: string,
        success: boolean,
        context?: Omit<LogContext, 'action'>,
    ): void {
        const ctx = this.buildContext({ ...context, action, success });

        if (success) {
            this.logger.log(ctx);
        } else {
            this.logger.warn(ctx);
        }
    }

    logDbOperation(
        operation: 'create' | 'read' | 'update' | 'delete',
        table: string,
        duration: number,
        context?: Omit<LogContext, 'action'>,
    ): void {
        const isSlowQuery = duration > 1000;
        const ctx = this.buildContext({
            ...context,
            action: `db.${operation}`,
            table,
            duration,
            slow: isSlowQuery,
        });

        if (isSlowQuery) {
            this.logger.warn(ctx);
        } else {
            this.logger.debug(ctx);
        }
    }

    logExternalCall(
        service: string,
        operation: string,
        duration: number,
        success: boolean,
        context?: Omit<LogContext, 'action'>,
    ): void {
        const ctx = this.buildContext({
            ...context,
            action: `external.${service}.${operation}`,
            duration,
            success,
        });

        if (success) {
            this.logger.log(ctx);
        } else {
            this.logger.error(ctx);
        }
    }
}

export function Log(
    action: string,
    options?: { logParams?: boolean; logResult?: boolean },
) {
    return function (
        target: any,
        propertyKey: string,
        descriptor: PropertyDescriptor,
    ) {
        const originalMethod = descriptor.value;

        descriptor.value = async function (...args: any[]) {
            const logger = new Logger(target.constructor.name);
            const startTime = Date.now();

            const logContext: Record<string, unknown> = {
                action,
                method: propertyKey,
            };

            if (options?.logParams) {
                logContext.params = args;
            }

            try {
                const result = await originalMethod.apply(this, args);
                const duration = Date.now() - startTime;

                logger.log({
                    ...logContext,
                    success: true,
                    duration,
                    ...(options?.logResult ? { result } : {}),
                });

                return result;
            } catch (error) {
                const duration = Date.now() - startTime;

                logger.error({
                    ...logContext,
                    success: false,
                    duration,
                    error:
                        error instanceof Error
                            ? error.message
                            : 'Unknown error',
                });

                throw error;
            }
        };

        return descriptor;
    };
}
