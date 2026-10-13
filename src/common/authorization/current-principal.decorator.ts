import {
    createParamDecorator,
    UnauthorizedException,
    type ExecutionContext,
} from '@nestjs/common';
import type { AccessPrincipal } from './access.types';

export const CurrentPrincipal = createParamDecorator(
    (_data: unknown, context: ExecutionContext): AccessPrincipal => {
        const request = context.switchToHttp().getRequest();
        const principal =
            request.accessPrincipal ??
            (request.user?.sub
                ? { type: 'USER', userId: request.user.sub }
                : null);
        if (!principal || principal.type === 'SYSTEM') {
            throw new UnauthorizedException('Authentication required');
        }
        return principal;
    },
);
