import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
} from '@nestjs/common';
import type { JwtPayload } from '../interfaces/jwt-payload.interface';

@Injectable()
export class SuperAdminGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest();
        const user = request['user'] as JwtPayload | undefined;

        if (!user) {
            throw new ForbiddenException('Authentication required');
        }

        if (user.globalRole !== 'SUPER_ADMIN') {
            throw new ForbiddenException('Super admin role required');
        }

        return true;
    }
}
