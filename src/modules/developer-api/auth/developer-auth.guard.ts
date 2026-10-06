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
            return true;
        }

        await this.authenticatePat(request, rawToken, orgId, requiredScopes);
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
        // The audit interceptor derives actorId from request.user. API keys are
        // not users, so attribute the action to the user who created the key.
        if (apiKey.createdById) {
            request['user'] = {
                sub: apiKey.createdById,
                email: 'api-key',
                globalRole: GlobalRole.USER,
            };
        }
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
        if (!pat) {
            throw new UnauthorizedException(
                'Personal access token revoked or expired',
            );
        }

        if (!orgId) {
            throw new ForbiddenException('Organization context required');
        }

        // PATs act as their user, so tenant isolation still requires a membership.
        if (payload.globalRole !== GlobalRole.SUPER_ADMIN) {
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
        request['user'] = payload;
    }

    // -- Helpers ----------------------------------------------------------

    private assertScopes(
        granted: string[],
        required: ApiScope[] | undefined,
    ): void {
        if (!required?.length) return;

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
