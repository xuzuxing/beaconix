import {
    ForbiddenException,
    NotFoundException,
    type ExecutionContext,
} from '@nestjs/common';
import { OrgMemberGuard } from './org-member.guard';
import { RolesGuard } from './roles.guard';

function setup() {
    const db = {
        user: {
            findFirst: jest.fn().mockResolvedValue({ globalRole: 'USER' }),
        },
        organization: { findFirst: jest.fn().mockResolvedValue({ id: 'org' }) },
        membership: {
            findUnique: jest
                .fn()
                .mockResolvedValue({ id: 'membership', role: 'MEMBER' }),
        },
    };
    const request = {
        user: { sub: 'user', globalRole: 'SUPER_ADMIN' },
        params: { orgId: 'org' },
    };
    const context = {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => jest.fn(),
        getClass: () => OrgMemberGuard,
    } as unknown as ExecutionContext;
    const guards = [
        new OrgMemberGuard(db as never),
        new RolesGuard(
            { getAllAndOverride: () => ['ADMIN'] } as never,
            db as never,
        ),
    ];
    return { db, guards, context };
}
describe('Organization guards current authority', () => {
    it('does not trust a stale SUPER_ADMIN token', async () => {
        const { db, guards, context } = setup();
        db.membership.findUnique.mockResolvedValue(null);
        for (const guard of guards) {
            await expect(guard.canActivate(context)).rejects.toThrow(
                ForbiddenException,
            );
        }
    });
    it('requires an existing active organization even for current platform administrators', async () => {
        const { db, guards, context } = setup();
        db.user.findFirst.mockResolvedValue({ globalRole: 'SUPER_ADMIN' });
        db.organization.findFirst.mockResolvedValue(null);
        for (const guard of guards)
            await expect(guard.canActivate(context)).rejects.toThrow(
                NotFoundException,
            );
        expect(db.membership.findUnique).not.toHaveBeenCalled();
    });
    it('allows current platform administrators without a fabricated membership', async () => {
        const { db, guards, context } = setup();
        db.user.findFirst.mockResolvedValue({ globalRole: 'SUPER_ADMIN' });
        db.membership.findUnique.mockResolvedValue(null);
        for (const guard of guards)
            await expect(guard.canActivate(context)).resolves.toBe(true);
        expect(db.membership.findUnique).not.toHaveBeenCalled();
    });
    it('rejects inactive identities', async () => {
        const { db, guards, context } = setup();
        db.user.findFirst.mockResolvedValue(null);
        for (const guard of guards)
            await expect(guard.canActivate(context)).rejects.toThrow(
                ForbiddenException,
            );
    });
});
