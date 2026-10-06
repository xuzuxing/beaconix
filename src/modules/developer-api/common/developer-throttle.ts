import { ExecutionContext } from '@nestjs/common';

/**
 * Identifies developer API routes for the named `developer` throttler so it
 * only applies to /api/developer/v1, while the default throttler keeps
 * covering every other route.
 */
export function isDeveloperApiRoute(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ path?: string }>();
    return (
        typeof request?.path === 'string' &&
        request.path.startsWith('/api/developer/v1')
    );
}
