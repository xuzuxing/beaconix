import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { GlobalRole } from '../../../generated/prisma/enums';
import type { JwtPayload } from '../../../common/interfaces/jwt-payload.interface';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ApiCredentialsService } from '../credentials/api-credentials.service';
import { API_KEY_PREFIX } from '../common/credentials.util';
import { REQUIRE_SCOPES_KEY } from './require-scopes.decorator';
import { ApiScope } from '../common/scopes';
import { ProjectAccessService } from '../../../common/authorization/project-access.service';
import type { AccessPrincipal } from '../../../common/authorization/access.types';

type PatPayload = JwtPayload & {
    kind?: 'pat';
    patId?: string;
};

/**
 * Authenticates programmatic credentials on the developer API:
 *  - organization API keys (`bk_org_...`), and
 *  - personal access tokens (revocable user JWTs with `kind: 'pat'`).
 *
 * Routes using this guard must also be marked `@Public()` so the global
 * JwtAuthGuard leaves them alone.
 */
@Injectable()
export class DeveloperAuthGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly credentialsService: ApiCredentialsService,
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
        private readonly access: ProjectAccessService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<Request>();
        const rawToken = this.extractBearerToken(request);
        if (!rawToken) {
            throw new UnauthorizedException('Missing access token');
        }

        const requiredScopes = this.reflector.getAllAndOverride<
            ApiScope[] | undefined
        >(REQUIRE_SCOPES_KEY, [context.getHandler(), context.getClass()]);
        const orgId = await this.resolveOrgId(request);

        if (rawToken.startsWith(API_KEY_PREFIX)) {
            await this.authenticateApiKey(
                request,
                rawToken,
                orgId,
                requiredScopes,
            );
        } else {
            await this.authenticatePat(
                request,
                rawToken,
                orgId,
                requiredScopes,
            );
        }
        const principal = request['accessPrincipal'] as AccessPrincipal;
        const organization = await this.access.organization(principal, orgId!);
        // Shared infrastructure and status-page management are organization
        // administration, even when the credential carries write scopes.
        if (
            requiredScopes?.some(
                (scope) =>
                    scope.startsWith('probes:') ||
                    scope.startsWith('status-pages:'),
            ) &&
            principal.type === 'USER' &&
            !organization.canManageOrganization
        ) {
            throw new ForbiddenException('Organization administrator required');
        }
        return true;
    }

    // -- Credential-specific flows ---------------------------------------

    private async authenticateApiKey(
        request: Request,
        rawKey: string,
        orgId: string | undefined,
        requiredScopes: ApiScope[] | undefined,
    ): Promise<void> {
        const apiKey = await this.credentialsService.findValidApiKey(rawKey);
        if (!apiKey) {
            throw new UnauthorizedException('Invalid or expired API key');
        }

        if (!orgId) {
            throw new ForbiddenException('Organization context required');
        }
        if (apiKey.organizationId !== orgId) {
            throw new ForbiddenException(
                'API key does not belong to this organization',
            );
        }

        this.assertScopes(apiKey.scopes, requiredScopes);
        this.credentialsService.touchApiKey(apiKey.id);

        request['authType'] = 'apiKey';
        request['apiKey'] = apiKey;
        request['accessPrincipal'] = {
            type: 'API_KEY',
            keyId: apiKey.id,
            organizationId: orgId,
        };
        delete request['user'];
    }

    private async authenticatePat(
        request: Request,
        rawToken: string,
        orgId: string | undefined,
        requiredScopes: ApiScope[] | undefined,
    ): Promise<void> {
        let payload: PatPayload;
        try {
            payload = await this.jwtService.verifyAsync<PatPayload>(rawToken);
        } catch {
            throw new UnauthorizedException('Invalid or expired access token');
        }

        if (payload.kind !== 'pat' || !payload.patId) {
            throw new UnauthorizedException(
                'Only API keys or personal access tokens are accepted here',
            );
        }

        const pat = await this.credentialsService.findValidPatById(
            payload.patId,
        );
        if (!pat || pat.userId !== payload.sub) {
            throw new UnauthorizedException(
                'Personal access token revoked or expired',
            );
        }

        if (!orgId) {
            throw new ForbiddenException('Organization context required');
        }

        const user = await this.prisma.user.findFirst({
            where: { id: payload.sub, isActive: true, deletedAt: null },
            select: { email: true, globalRole: true },
        });
        if (!user) throw new UnauthorizedException('User is no longer active');
        if (user.globalRole !== GlobalRole.SUPER_ADMIN) {
            const membership = await this.prisma.membership.findUnique({
                where: {
                    userId_organizationId: {
                        userId: payload.sub,
                        organizationId: orgId,
                    },
                },
            });
            if (!membership) {
                throw new ForbiddenException(
                    'You are not a member of this organization',
                );
            }
        }

        this.assertScopes(pat.scopes, requiredScopes);
        this.credentialsService.touchPat(pat.id);

        request['authType'] = 'pat';
        request['patId'] = pat.id;
        request['user'] = {
            ...payload,
            email: user.email,
            globalRole: user.globalRole,
        };
        request['accessPrincipal'] = {
            type: 'USER',
            userId: payload.sub,
            patId: pat.id,
        };
    }

    // -- Helpers ----------------------------------------------------------

    private assertScopes(
        granted: string[],
        required: ApiScope[] | undefined,
    ): void {
        if (!required?.length)
            throw new ForbiddenException('Credential scope metadata required');

        const missing = required.filter((scope) => !granted.includes(scope));
        if (missing.length > 0) {
            throw new ForbiddenException(
                `Missing scope: ${missing.join(', ')}`,
            );
        }
    }

    private extractBearerToken(request: Request): string | null {
        const [type, token] = request.headers.authorization?.split(' ') ?? [];
        return type === 'Bearer' ? token : null;
    }

    private async resolveOrgId(request: any): Promise<string | undefined> {
        const orgId = request.params?.orgId as string | undefined;
        if (orgId) return orgId;

        const projectId = request.params?.projectId as string | undefined;
        if (projectId) {
            const project = await this.prisma.project.findFirst({
                where: { id: projectId, deletedAt: null },
                select: { organizationId: true },
            });
            if (!project) throw new NotFoundException('Project not found');
            request['projectOrgId'] = project.organizationId;
            return project.organizationId;
        }

        return undefined;
    }
}
