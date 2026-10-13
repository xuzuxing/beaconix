import { OrganizationsService } from './organizations.service';
import type { PrismaService } from '../../infra/database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';

function fixture() {
    const org = {
        id: 'org',
        name: 'Team',
        ownerId: 'owner',
        updatedAt: new Date(),
    };
    const db = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        user: { findFirst: jest.fn().mockResolvedValue({ id: 'active-user' }) },
        auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit' }) },
        organization: {
            findUnique: jest.fn().mockResolvedValue(org),
            update: jest
                .fn()
                .mockImplementation(({ data }) => ({ ...org, ...data })),
        },
        membership: {
            findUnique: jest.fn().mockImplementation(({ where }) =>
                Promise.resolve(
                    where.userId_organizationId?.userId === 'owner'
                        ? {
                              id: 'owner-membership',
                              userId: 'owner',
                              role: 'OWNER',
                              projectPermissionsVersion: 2,
                          }
                        : {
                              id: 'membership',
                              userId: 'member',
                              role: 'MEMBER',
                              projectPermissionsVersion: 3,
                          },
                ),
            ),
            findMany: jest.fn().mockResolvedValue([
                { id: 'owner-membership', userId: 'owner', role: 'OWNER' },
                { id: 'admin-membership', userId: 'admin', role: 'ADMIN' },
                { id: 'membership', userId: 'member', role: 'MEMBER' },
            ]),
            update: jest.fn().mockResolvedValue({}),
        },
        $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation((work) => work(db));
    const notifications = {
        publish: jest.fn().mockResolvedValue(undefined),
        organizationRecipients: jest.fn().mockResolvedValue(['owner', 'admin']),
    };
    const service = new OrganizationsService(
        db as unknown as PrismaService,
        notifications as unknown as NotificationsService,
    );
    return { service, db, notifications };
}

describe('Organization lifecycle notifications', () => {
    it('notifies members on deletion, with email only for owners/admins', async () => {
        const { service, db, notifications } = fixture();
        await service.softDelete('org', 'owner');
        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'ORGANIZATION_DELETED',
                actorId: 'owner',
                allowOutsideOrg: true,
                recipients: [
                    { userId: 'owner', email: true },
                    { userId: 'admin', email: true },
                    { userId: 'member', email: false },
                ],
            }),
            db,
        );
        expect(db.organization.update).toHaveBeenCalledWith({
            where: { id: 'org' },
            data: { deletedAt: expect.any(Date) },
        });
    });

    it('notifies old/new owners and admins atomically with permission changes', async () => {
        const { service, db, notifications } = fixture();
        await service.transferOwnership('org', 'owner', {
            newOwnerId: 'member',
        });
        expect(db.membership.update).toHaveBeenCalledTimes(2);
        expect(db.auditLog.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    entity: 'OrganizationOwnership',
                    after: {
                        ownerId: 'member',
                        memberships: [
                            {
                                membershipId: 'owner-membership',
                                userId: 'owner',
                                role: 'ADMIN',
                                projectPermissionsVersion: 3,
                            },
                            {
                                membershipId: 'membership',
                                userId: 'member',
                                role: 'OWNER',
                                projectPermissionsVersion: 4,
                            },
                        ],
                    },
                }),
            }),
        );
        expect(db.membership.update).toHaveBeenNthCalledWith(1, {
            where: { id: 'membership' },
            data: {
                role: 'OWNER',
                projectPermissionsVersion: { increment: 1 },
            },
        });
        expect(db.membership.update).toHaveBeenNthCalledWith(2, {
            where: {
                userId_organizationId: {
                    userId: 'owner',
                    organizationId: 'org',
                },
            },
            data: {
                role: 'ADMIN',
                projectPermissionsVersion: { increment: 1 },
            },
        });
        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'OWNERSHIP_TRANSFERRED',
                includeActor: true,
                email: true,
                recipients: ['owner', 'member', 'owner', 'admin'],
                meta: { previousOwnerId: 'owner', newOwnerId: 'member' },
            }),
            db,
        );
    });

    it('does not notify on denied or self-transfer operations', async () => {
        const { service, notifications } = fixture();
        await expect(
            service.transferOwnership('org', 'admin', { newOwnerId: 'member' }),
        ).rejects.toThrow('Only the owner');
        await expect(
            service.transferOwnership('org', 'owner', { newOwnerId: 'owner' }),
        ).rejects.toThrow('already the owner');
        expect(notifications.publish).not.toHaveBeenCalled();
    });
});
