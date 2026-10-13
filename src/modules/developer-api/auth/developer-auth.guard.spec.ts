import {
    ExecutionContext,
    ForbiddenException,
    UnauthorizedException,
} from '@nestjs/common';
import { DeveloperAuthGuard } from './developer-auth.guard';
import type { PrismaService } from '../../../infra/database/prisma.service';
import { mockProjectAccess } from '../../../common/authorization/access-test.fixture';

function createGuard(requiredScopes: string[] | undefined = ['monitors:read']) {
    const reflector = {
        getAllAndOverride: jest.fn().mockReturnValue(requiredScopes),
    };
    const credentialsService = {
        findValidApiKey: jest.fn(),
        touchApiKey: jest.fn(),
        findValidPatById: jest.fn(),
        touchPat: jest.fn(),
    };
    const prisma = {
        user: {
            findFirst: jest.fn().mockResolvedValue({
                email: 'dev@example.com',
                globalRole: 'USER',
            }),
        },
        project: { findFirst: jest.fn() },
        membership: { findUnique: jest.fn() },
    };
    const jwtService = { verifyAsync: jest.fn() };

    const guard = new DeveloperAuthGuard(
        reflector as any,
        credentialsService as any,
        prisma as unknown as PrismaService,
        jwtService as any,
        mockProjectAccess(prisma),
    );

    return { guard, reflector, credentialsService, prisma, jwtService };
}

function contextWithRequest(
    request: Record<string, unknown>,
): ExecutionContext {
    return {
        switchToHttp: () => ({
            getRequest: () => request,
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
    } as unknown as ExecutionContext;
}

const validKey = {
    id: 'key-1',
    organizationId: 'org-1',
    createdById: 'user-1',
    scopes: ['monitors:read', 'monitors:write'],
};

const validPat = {
    id: 'pat-1',
    userId: 'user-1',
    scopes: ['monitors:read'],
};

describe('DeveloperAuthGuard', () => {
    it('rejects requests without a bearer token', async () => {
        const { guard } = createGuard();
        const ctx = contextWithRequest({ headers: {}, params: {} });

        await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
            UnauthorizedException,
        );
    });

    describe('API keys', () => {
        it('rejects a key that belongs to another organization', async () => {
            const { guard, credentialsService } = createGuard();
            credentialsService.findValidApiKey.mockResolvedValue(validKey);
            const ctx = contextWithRequest({
                headers: { authorization: 'Bearer bk_org_abc' },
                params: { orgId: 'org-other' },
            });

            await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
                ForbiddenException,
            );
        });

        it('rejects when a required scope is missing', async () => {
            const { guard, credentialsService } = createGuard(['probes:read']);
            credentialsService.findValidApiKey.mockResolvedValue(validKey);
            const ctx = contextWithRequest({
                headers: { authorization: 'Bearer bk_org_abc' },
                params: { orgId: 'org-1' },
            });

            await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
                ForbiddenException,
            );
        });

        it('attaches the machine principal without fabricating a creator user', async () => {
            const { guard, credentialsService } = createGuard([
                'monitors:read',
            ]);
            credentialsService.findValidApiKey.mockResolvedValue(validKey);
            const request = {
                headers: { authorization: 'Bearer bk_org_abc' },
                params: { orgId: 'org-1' },
            };
            const ctx = contextWithRequest(request);

            await expect(guard.canActivate(ctx)).resolves.toBe(true);
            expect(request['apiKey']).toEqual(validKey);
            expect(request['authType']).toBe('apiKey');
            expect(request['user']).toBeUndefined();
            expect(request['accessPrincipal']).toEqual({
                type: 'API_KEY',
                keyId: 'key-1',
                organizationId: 'org-1',
            });
        });

        it('resolves the organization through projectId', async () => {
            const { guard, credentialsService, prisma } = createGuard();
            credentialsService.findValidApiKey.mockResolvedValue(validKey);
            prisma.project.findFirst.mockResolvedValue({
                organizationId: 'org-1',
            });
            const request = {
                headers: { authorization: 'Bearer bk_org_abc' },
                params: { projectId: 'project-1' },
            };
            const ctx = contextWithRequest(request);

            await expect(guard.canActivate(ctx)).resolves.toBe(true);
            expect(request['projectOrgId']).toBe('org-1');
        });
    });

    describe('Personal access tokens', () => {
        it('rejects an inactive user despite a valid token and stale SUPER_ADMIN claim', async () => {
            const { guard, jwtService, credentialsService, prisma } =
                createGuard();
            jwtService.verifyAsync.mockResolvedValue({
                sub: 'user-1',
                kind: 'pat',
                patId: 'pat-1',
                globalRole: 'SUPER_ADMIN',
            });
            credentialsService.findValidPatById.mockResolvedValue(validPat);
            prisma.user.findFirst.mockResolvedValue(null);
            await expect(
                guard.canActivate(
                    contextWithRequest({
                        headers: { authorization: 'Bearer jwt' },
                        params: { orgId: 'org-1' },
                    }),
                ),
            ).rejects.toThrow(UnauthorizedException);
            expect(credentialsService.touchPat).not.toHaveBeenCalled();
        });

        it('uses current database role instead of an old SUPER_ADMIN claim', async () => {
            const { guard, jwtService, credentialsService, prisma } =
                createGuard();
            jwtService.verifyAsync.mockResolvedValue({
                sub: 'user-1',
                kind: 'pat',
                patId: 'pat-1',
                globalRole: 'SUPER_ADMIN',
            });
            credentialsService.findValidPatById.mockResolvedValue(validPat);
            prisma.membership.findUnique.mockResolvedValue(null);
            await expect(
                guard.canActivate(
                    contextWithRequest({
                        headers: { authorization: 'Bearer jwt' },
                        params: { orgId: 'org-1' },
                    }),
                ),
            ).rejects.toThrow(ForbiddenException);
            expect(prisma.membership.findUnique).toHaveBeenCalled();
        });

        it.each(['probes:read', 'status-pages:write'])(
            'requires organization administration for shared scope %s',
            async (scope) => {
                const { guard, jwtService, credentialsService, prisma } =
                    createGuard([scope]);
                jwtService.verifyAsync.mockResolvedValue({
                    sub: 'user-1',
                    kind: 'pat',
                    patId: 'pat-1',
                });
                credentialsService.findValidPatById.mockResolvedValue({
                    ...validPat,
                    scopes: [scope],
                });
                prisma.membership.findUnique.mockResolvedValue({
                    id: 'm-1',
                    role: 'MEMBER',
                });
                jest.spyOn(guard['access'], 'organization').mockResolvedValue({
                    principal: {
                        type: 'USER',
                        userId: 'user-1',
                        patId: 'pat-1',
                    },
                    organizationId: 'org-1',
                    globalRole: 'USER',
                    organizationRole: 'MEMBER',
                    membershipId: 'm-1',
                    projectPermissionsVersion: 1,
                    platformAuthorityVersion: null,
                    accessMode: 'SELECTED_PROJECTS',
                    canManageOrganization: false,
                    canGrantOrganizationAdmin: false,
                });
                await expect(
                    guard.canActivate(
                        contextWithRequest({
                            headers: { authorization: 'Bearer jwt' },
                            params: { orgId: 'org-1' },
                        }),
                    ),
                ).rejects.toThrow('Organization administrator required');
            },
        );
        it('rejects non-PAT JWTs', async () => {
            const { guard, jwtService } = createGuard();
            jwtService.verifyAsync.mockResolvedValue({ sub: 'user-1' });
            const ctx = contextWithRequest({
                headers: { authorization: 'Bearer jwt' },
                params: { orgId: 'org-1' },
            });

            await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
                UnauthorizedException,
            );
        });

        it('rejects revoked PATs', async () => {
            const { guard, jwtService, credentialsService } = createGuard();
            jwtService.verifyAsync.mockResolvedValue({
                sub: 'user-1',
                kind: 'pat',
                patId: 'pat-1',
            });
            credentialsService.findValidPatById.mockResolvedValue(null);
            const ctx = contextWithRequest({
                headers: { authorization: 'Bearer jwt' },
                params: { orgId: 'org-1' },
            });

            await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
                UnauthorizedException,
            );
        });

        it('rejects a PAT whose user is not an org member', async () => {
            const { guard, jwtService, credentialsService, prisma } =
                createGuard();
            jwtService.verifyAsync.mockResolvedValue({
                sub: 'user-1',
                email: 'dev@example.com',
                globalRole: 'USER',
                kind: 'pat',
                patId: 'pat-1',
            });
            credentialsService.findValidPatById.mockResolvedValue(validPat);
            prisma.membership.findUnique.mockResolvedValue(null);
            const ctx = contextWithRequest({
                headers: { authorization: 'Bearer jwt' },
                params: { orgId: 'org-1' },
            });

            await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
                ForbiddenException,
            );
        });

        it('enforces PAT scopes', async () => {
            const { guard, jwtService, credentialsService, prisma } =
                createGuard(['monitors:write']);
            jwtService.verifyAsync.mockResolvedValue({
                sub: 'user-1',
                email: 'dev@example.com',
                globalRole: 'USER',
                kind: 'pat',
                patId: 'pat-1',
            });
            credentialsService.findValidPatById.mockResolvedValue(validPat);
            prisma.membership.findUnique.mockResolvedValue({ id: 'm-1' });
            const ctx = contextWithRequest({
                headers: { authorization: 'Bearer jwt' },
                params: { orgId: 'org-1' },
            });

            await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
                ForbiddenException,
            );
        });

        it('attaches the user context for a valid PAT', async () => {
            const { guard, jwtService, credentialsService, prisma } =
                createGuard(['monitors:read']);
            jwtService.verifyAsync.mockResolvedValue({
                sub: 'user-1',
                email: 'dev@example.com',
                globalRole: 'USER',
                kind: 'pat',
                patId: 'pat-1',
            });
            credentialsService.findValidPatById.mockResolvedValue(validPat);
            prisma.membership.findUnique.mockResolvedValue({ id: 'm-1' });
            const request = {
                headers: { authorization: 'Bearer jwt' },
                params: { orgId: 'org-1' },
            };
            const ctx = contextWithRequest(request);

            await expect(guard.canActivate(ctx)).resolves.toBe(true);
            expect(request['authType']).toBe('pat');
            expect(request['patId']).toBe('pat-1');
            expect(request['user']).toEqual(
                expect.objectContaining({ sub: 'user-1' }),
            );
        });
    });

    it.each([undefined, []])(
        'fails closed without scope metadata (%s)',
        async (scopes) => {
            const { guard, reflector, credentialsService } = createGuard();
            reflector.getAllAndOverride.mockReturnValue(scopes);
            credentialsService.findValidApiKey.mockResolvedValue(validKey);
            await expect(
                guard.canActivate(
                    contextWithRequest({
                        headers: { authorization: 'Bearer bk_org_abc' },
                        params: { orgId: 'org-1' },
                    }),
                ),
            ).rejects.toThrow('Credential scope metadata required');
            expect(credentialsService.touchApiKey).not.toHaveBeenCalled();
        },
    );
});
