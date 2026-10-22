import {
    Injectable,
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MembershipRole } from '../../generated/prisma/enums';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PrismaService } from '../../infra/database/prisma.service';
import type { JwtPayload } from '../interfaces/jwt-payload.interface';
import { resolveTenant } from '../../infra/tenant/resolve-tenant';

@Injectable()
export class RolesGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly prisma: PrismaService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const requiredRoles = this.reflector.getAllAndOverride<
            MembershipRole[] | undefined
        >(ROLES_KEY, [context.getHandler(), context.getClass()]);

        if (!requiredRoles || requiredRoles.length === 0) return true;

        const request = context.switchToHttp().getRequest();
        const user = request['user'] as JwtPayload | undefined;
        if (!user) throw new ForbiddenException('Authentication required');

        const orgId = await resolveTenant(this.prisma, request);
        if (!orgId) {
            throw new ForbiddenException(
                'Organization context required for role check',
            );
        }
        const currentUser = await this.prisma.user.findFirst({
            where: { id: user.sub, isActive: true, deletedAt: null },
            select: { globalRole: true },
        });
        if (!currentUser)
            throw new ForbiddenException('User is no longer active');
        const organization = await this.prisma.organization.findFirst({
            where: { id: orgId, deletedAt: null },
            select: { id: true },
        });
        if (!organization)
            throw new NotFoundException('Organization not found');
        if (currentUser.globalRole === 'SUPER_ADMIN') return true;

        const membership = await this.prisma.membership.findUnique({
            where: {
                userId_organizationId: {
                    userId: user.sub,
                    organizationId: orgId,
                },
            },
        });

        if (!membership) {
            throw new ForbiddenException(
                'You are not a member of this organization',
            );
        }

        const roleHierarchy: Record<MembershipRole, number> = {
            OWNER: 4,
            ADMIN: 3,
            MEMBER: 2,
            VIEWER: 1,
        };

        const userLevel = roleHierarchy[membership.role];
        const minRequired = Math.min(
            ...requiredRoles.map((r) => roleHierarchy[r]),
        );

        if (userLevel < minRequired) {
            throw new ForbiddenException('Insufficient role');
        }

        // Attach membership to request for downstream use
        request['membership'] = membership;

        return true;
    }
}
