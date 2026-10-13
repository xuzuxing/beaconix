import {
    ForbiddenException,
    UnauthorizedException,
    type ExecutionContext,
} from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

function setup(
    payload = {
        sub: 'user',
        email: 'old@example.com',
        globalRole: 'SUPER_ADMIN',
    } as Record<string, unknown>,
) {
    const request = {
        headers: { authorization: 'Bearer test-token' },
    } as Record<string, any>;
    const jwt = { verifyAsync: jest.fn().mockResolvedValue(payload) };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    const prisma = {
        user: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'user',
                email: 'current@example.com',
                globalRole: 'USER',
            }),
        },
    };
    const context = {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => jest.fn(),
        getClass: () => JwtAuthGuard,
    } as unknown as ExecutionContext;
    return {
        guard: new JwtAuthGuard(
            jwt as never,
            reflector as never,
            prisma as never,
        ),
        request,
        jwt,
        reflector,
        prisma,
        context,
    };
}

describe('JwtAuthGuard current identity and credential boundary', () => {
    it('rejects PATs on ordinary APIs before any business authorization', async () => {
        const { guard, context, prisma, request } = setup({
            sub: 'admin',
            kind: 'pat',
            patId: 'readonly-token',
        });
        await expect(guard.canActivate(context)).rejects.toThrow(
            ForbiddenException,
        );
        expect(prisma.user.findFirst).not.toHaveBeenCalled();
        expect(request.user).toBeUndefined();
    });
    it('replaces stale token role and email with the current database identity', async () => {
        const { guard, context, prisma, request } = setup();
        await expect(guard.canActivate(context)).resolves.toBe(true);
        expect(request.user).toMatchObject({
            sub: 'user',
            email: 'current@example.com',
            globalRole: 'USER',
        });
        expect(request.accessPrincipal).toEqual({
            type: 'USER',
            userId: 'user',
        });
        expect(prisma.user.findFirst).toHaveBeenCalledWith({
            where: { id: 'user', isActive: true, deletedAt: null },
            select: { id: true, email: true, globalRole: true },
        });
    });
    it('rejects inactive or deleted users despite a valid JWT', async () => {
        const { guard, context, prisma, request } = setup();
        prisma.user.findFirst.mockResolvedValue(null);
        await expect(guard.canActivate(context)).rejects.toThrow(
            UnauthorizedException,
        );
        expect(request.user).toBeUndefined();
    });
    it('requires authentication and rejects invalid signatures', async () => {
        const { guard, context, request, jwt } = setup();
        request.headers = {};
        await expect(guard.canActivate(context)).rejects.toThrow(
            UnauthorizedException,
        );
        request.headers = { authorization: 'Bearer test-token' };
        jwt.verifyAsync.mockRejectedValue(new Error('bad signature'));
        await expect(guard.canActivate(context)).rejects.toThrow(
            UnauthorizedException,
        );
    });
    it('rejects missing subject and unknown credential kinds', async () => {
        for (const payload of [
            { email: 'no-sub' },
            { sub: 'user', kind: 'refresh' },
        ]) {
            const { guard, context, prisma } = setup(payload);
            await expect(guard.canActivate(context)).rejects.toThrow(
                UnauthorizedException,
            );
            expect(prisma.user.findFirst).not.toHaveBeenCalled();
        }
    });
    it('leaves explicitly public routes to their own authentication', async () => {
        const { guard, context, reflector, jwt } = setup();
        reflector.getAllAndOverride.mockReturnValue(true);
        await expect(guard.canActivate(context)).resolves.toBe(true);
        expect(jwt.verifyAsync).not.toHaveBeenCalled();
    });
});
