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
        organization: {
            findUnique: jest.fn().mockResolvedValue(org),
            update: jest
                .fn()
                .mockImplementation(({ data }) => ({ ...org, ...data })),
        },
        membership: {
            findUnique: jest
                .fn()
                .mockResolvedValue({ id: 'membership', userId: 'member' }),
            findMany: jest.fn().mockResolvedValue([
                { userId: 'owner', role: 'OWNER' },
                { userId: 'admin', role: 'ADMIN' },
                { userId: 'member', role: 'MEMBER' },
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
