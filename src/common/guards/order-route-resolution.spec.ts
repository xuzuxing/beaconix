import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { OrgMemberGuard } from './org-member.guard';
import { RolesGuard } from './roles.guard';

const ORDER_ID = 'cmvgs8q150001k4uzey9g74e7';
const ORG_ID = 'org-1';

function setup(options?: {
    order?: { organizationId: string } | null;
    membership?: { id: string; role: string } | null;
    requiredRoles?: string[];
}) {
    const db = {
        user: {
            findFirst: jest.fn().mockResolvedValue({ globalRole: 'USER' }),
        },
        organization: {
            findFirst: jest
                .fn()
                .mockImplementation((args: { where: { id: string } }) =>
                    Promise.resolve(
                        args.where.id === ORG_ID ? { id: ORG_ID } : null,
                    ),
                ),
        },
        label: { findUnique: jest.fn().mockResolvedValue(null) },
        order: {
            findUnique: jest
                .fn()
                .mockResolvedValue(
                    options?.order === undefined
                        ? { organizationId: ORG_ID }
                        : options.order,
                ),
        },
        membership: {
            findUnique: jest
                .fn()
                .mockResolvedValue(
                    options?.membership === undefined
                        ? { id: 'membership-1', role: 'ADMIN' }
                        : options.membership,
                ),
        },
    };

    const request: Record<string, unknown> = {
        user: { sub: 'user-1' },
        // `/orders/:id/refunds` 这类路由的参数形状
        params: { id: ORDER_ID },
    };

    const context = {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => jest.fn(),
        getClass: () => OrgMemberGuard,
    } as unknown as ExecutionContext;

    const reflector = {
        getAllAndOverride: () => options?.requiredRoles ?? ['ADMIN'],
    };

    return {
        db,
        request,
        context,
        orgMemberGuard: new OrgMemberGuard(db as never),
        rolesGuard: new RolesGuard(reflector as never, db as never),
    };
}

describe('tenant resolution for /orders/:id routes', () => {
    it('resolves the tenant from the order id for OrgMemberGuard', async () => {
        const { db, request, context, orgMemberGuard } = setup();

        await expect(orgMemberGuard.canActivate(context)).resolves.toBe(true);

        expect(db.order.findUnique).toHaveBeenCalledWith({
            where: { id: ORDER_ID },
            select: { organizationId: true },
        });
        // 供审计拦截器复用的解析结果
        expect(request['orderOrgId']).toBe(ORG_ID);
    });

    it('resolves the tenant from the order id for RolesGuard', async () => {
        const { db, context, rolesGuard } = setup();

        await expect(rolesGuard.canActivate(context)).resolves.toBe(true);

        expect(db.order.findUnique).toHaveBeenCalled();
        expect(db.membership.findUnique).toHaveBeenCalledWith({
            where: {
                userId_organizationId: {
                    userId: 'user-1',
                    organizationId: ORG_ID,
                },
            },
        });
    });

    it('still fails when the order does not exist', async () => {
        const { context, orgMemberGuard } = setup({ order: null });

        await expect(orgMemberGuard.canActivate(context)).rejects.toThrow(
            new ForbiddenException('Organization context required'),
        );
    });

    it('rejects a user who is not a member of the order organization', async () => {
        const { context, orgMemberGuard } = setup({ membership: null });

        await expect(orgMemberGuard.canActivate(context)).rejects.toThrow(
            new ForbiddenException('You are not a member of this organization'),
        );
    });

    it('enforces the role hierarchy on top of the order resolution', async () => {
        const { context, rolesGuard } = setup({
            membership: { id: 'membership-1', role: 'MEMBER' },
            requiredRoles: ['ADMIN'],
        });

        await expect(rolesGuard.canActivate(context)).rejects.toThrow(
            new ForbiddenException('Insufficient role'),
        );
    });
});
