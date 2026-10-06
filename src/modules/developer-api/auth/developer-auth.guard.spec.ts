import {
    ExecutionContext,
    ForbiddenException,
    UnauthorizedException,
} from '@nestjs/common';
import { DeveloperAuthGuard } from './developer-auth.guard';
import type { PrismaService } from '../../../infra/database/prisma.service';

function createGuard(requiredScopes?: string[]) {
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
        project: { findFirst: jest.fn() },
        membership: { findUnique: jest.fn() },
    };
    const jwtService = { verifyAsync: jest.fn() };

    const guard = new DeveloperAuthGuard(
        reflector as any,
        credentialsService as any,
        prisma as unknown as PrismaService,
        jwtService as any,
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

        it('attaches the api key and user context when valid', async () => {
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
            expect(request['user']).toEqual(
                expect.objectContaining({ sub: 'user-1' }),
            );
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
});
