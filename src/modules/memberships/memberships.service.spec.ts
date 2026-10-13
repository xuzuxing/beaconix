import { Test } from '@nestjs/testing';
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
import { MembershipRole } from '../../generated/prisma/enums';
import { PrismaService } from '../../infra/database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { NotificationEvent } from '../notifications/notification-event';
import { MembershipsService } from './memberships.service';
import { ProjectAccessService } from '../../common/authorization/project-access.service';

const updatedAt = new Date('2026-10-11T08:00:00.000Z');

async function setup(role: MembershipRole = 'MEMBER') {
    const membership = {
        id: 'membership',
        userId: 'target',
        organizationId: 'org',
        role,
        joinedAt: new Date('2026-10-01T08:00:00.000Z'),
        updatedAt,
        invitedById: 'inviter',
        projectPermissionsVersion: 0,
        user: {
            id: 'target',
            name: 'Target',
            email: 'target@example.com',
            avatarUrl: null,
        },
    };
    let inTransaction = false;
    let currentMembership = membership;
    const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        membership: {
            updateMany: jest.fn().mockImplementation(({ data }) => {
                expect(inTransaction).toBe(true);
                currentMembership = {
                    ...currentMembership,
                    role: data.role,
                    projectPermissionsVersion:
                        currentMembership.projectPermissionsVersion + 1,
                };
                return Promise.resolve({ count: 1 });
            }),
            findUniqueOrThrow: jest.fn().mockImplementation(() => {
                expect(inTransaction).toBe(true);
                return Promise.resolve(currentMembership);
            }),
            delete: jest.fn().mockResolvedValue(membership),
            findUnique: jest.fn().mockResolvedValue(membership),
            findMany: jest.fn().mockResolvedValue([
                { id: 'membership', userId: 'target' },
                { id: 'actor-membership', userId: 'actor' },
            ]),
        },
        projectMembership: {
            updateMany: jest.fn().mockResolvedValue({ count: 2 }),
            findMany: jest
                .fn()
                .mockResolvedValue([{ projectId: 'project', role: 'ADMIN' }]),
        },
        auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit' }) },
    };
    const prisma = {
        membership: { findUnique: jest.fn().mockResolvedValue(membership) },
        $transaction: jest.fn().mockImplementation(async (callback) => {
            inTransaction = true;
            try {
                return await callback(tx);
            } finally {
                inTransaction = false;
            }
        }),
    };
    const notifications = {
        organizationRecipients: jest
            .fn()
            .mockResolvedValue(['owner', 'admin', 'actor']),
        publish: jest.fn().mockImplementation((_event, client) => {
            expect(inTransaction).toBe(true);
            expect(client).toBe(tx);
            return Promise.resolve();
        }),
    };
    const moduleRef = await Test.createTestingModule({
        providers: [
            MembershipsService,
            { provide: PrismaService, useValue: prisma },
            { provide: NotificationsService, useValue: notifications },
            {
                provide: ProjectAccessService,
                useValue: {
                    organization: jest.fn().mockResolvedValue({
                        canManageOrganization: true,
                        canGrantOrganizationAdmin: true,
                    }),
                },
            },
        ],
    }).compile();
    return {
        service: moduleRef.get(MembershipsService),
        prisma,
        tx,
        notifications,
        membership,
        event: (index = 0) =>
            notifications.publish.mock.calls[index][0] as NotificationEvent,
    };
}

describe('MembershipsService collaboration notifications', () => {
    it('does not mutate or notify an unchanged member role', async () => {
        const { service, prisma, tx, notifications, membership } =
            await setup();
        await expect(
            service.updateRole('org', 'target', 'actor', { role: 'MEMBER' }),
        ).resolves.toEqual(membership);
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(tx.membership.updateMany).not.toHaveBeenCalled();
        expect(tx.membership.findUniqueOrThrow).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
        expect(notifications.organizationRecipients).not.toHaveBeenCalled();
    });

    it('also keeps an unchanged ADMIN role silent', async () => {
        const { service, notifications, prisma } = await setup('ADMIN');
        await service.updateRole('org', 'target', 'actor', { role: 'ADMIN' });
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
        expect(notifications.organizationRecipients).not.toHaveBeenCalled();
    });

    it('returns the current member with user relation without notifying when a concurrent role change already applied the requested role', async () => {
        const { service, prisma, tx, notifications, membership } =
            await setup();
        const concurrent = {
            ...membership,
            role: MembershipRole.ADMIN,
            updatedAt: new Date('2026-10-11T08:01:00.000Z'),
        };
        tx.membership.updateMany.mockResolvedValue({ count: 0 });
        tx.membership.findUniqueOrThrow.mockResolvedValue(concurrent);
        await expect(
            service.updateRole('org', 'target', 'actor', { role: 'ADMIN' }),
        ).resolves.toEqual(concurrent);
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(tx.membership.updateMany).toHaveBeenCalledTimes(1);
        expect(tx.membership.updateMany).toHaveBeenCalledWith({
            where: { id: 'membership', role: 'MEMBER' },
            data: {
                role: 'ADMIN',
                projectPermissionsVersion: { increment: 1 },
            },
        });
        expect(tx.membership.findUniqueOrThrow).toHaveBeenCalledWith({
            where: { id: 'membership' },
            include: {
                user: {
                    select: {
                        id: true,
                        email: true,
                        name: true,
                        avatarUrl: true,
                    },
                },
            },
        });
        expect(
            tx.membership.updateMany.mock.invocationCallOrder[0],
        ).toBeLessThan(
            tx.membership.findUniqueOrThrow.mock.invocationCallOrder[0],
        );
        expect(notifications.publish).not.toHaveBeenCalled();
        expect(notifications.organizationRecipients).not.toHaveBeenCalled();
    });

    it.each(['VIEWER', 'OWNER'] as const)(
        'does not overwrite or notify a concurrent %s role when its conditional update loses',
        async (role) => {
            const { service, tx, notifications, membership } = await setup();
            tx.membership.updateMany.mockResolvedValue({ count: 0 });
            tx.membership.findUniqueOrThrow.mockResolvedValue({
                ...membership,
                role,
            });
            await expect(
                service.updateRole('org', 'target', 'actor', { role: 'ADMIN' }),
            ).rejects.toThrow(ConflictException);
            expect(tx.membership.updateMany).toHaveBeenCalledTimes(1);
            expect(tx.membership.updateMany).toHaveBeenCalledWith({
                where: { id: 'membership', role: 'MEMBER' },
                data: {
                    role: 'ADMIN',
                    projectPermissionsVersion: { increment: 1 },
                },
            });
            expect(notifications.publish).not.toHaveBeenCalled();
            expect(notifications.organizationRecipients).not.toHaveBeenCalled();
        },
    );

    it('notifies only the affected member for a non-administrative role change', async () => {
        const { service, prisma, tx, notifications, event } = await setup();
        await expect(
            service.updateRole('org', 'target', 'actor', { role: 'VIEWER' }),
        ).resolves.toMatchObject({ role: 'VIEWER' });
        expect(prisma.membership.findUnique).toHaveBeenCalledWith({
            include: {
                user: {
                    select: {
                        id: true,
                        email: true,
                        name: true,
                        avatarUrl: true,
                    },
                },
            },
            where: {
                userId_organizationId: {
                    userId: 'target',
                    organizationId: 'org',
                },
            },
        });
        expect(tx.membership.updateMany).toHaveBeenCalledWith({
            where: { id: 'membership', role: 'MEMBER' },
            data: {
                role: 'VIEWER',
                projectPermissionsVersion: { increment: 1 },
            },
        });
        expect(tx.projectMembership.updateMany).toHaveBeenCalledWith({
            where: { membershipId: 'membership', organizationId: 'org' },
            data: { role: 'VIEWER' },
        });
        expect(tx.auditLog.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    before: expect.objectContaining({
                        projects: [{ projectId: 'project', role: 'ADMIN' }],
                    }),
                    after: expect.objectContaining({
                        projects: [{ projectId: 'project', role: 'VIEWER' }],
                    }),
                }),
            }),
        );
        expect(event()).toMatchObject({
            eventKey: `membership-role:membership:${updatedAt.toISOString()}`,
            type: 'MEMBER_ROLE_CHANGED',
            actorId: 'actor',
            organizationId: 'org',
            resourceType: 'Organization',
            resourceId: 'org',
            recipients: [{ userId: 'target', email: true }],
            meta: { oldRole: 'MEMBER', newRole: 'VIEWER' },
        });
        expect(event().allowOutsideOrg).not.toBe(true);
        expect(event().includeActor).not.toBe(true);
        expect(notifications.organizationRecipients).not.toHaveBeenCalled();
        expect(
            tx.membership.updateMany.mock.invocationCallOrder[0],
        ).toBeLessThan(notifications.publish.mock.invocationCallOrder[0]);
    });

    it.each([
        ['MEMBER', 'ADMIN'],
        ['ADMIN', 'MEMBER'],
        ['ADMIN', 'VIEWER'],
    ] as const)(
        'targets current OWNER/ADMIN audiences on %s to %s',
        async (before, after) => {
            const { service, tx, notifications, event } = await setup(before);
            notifications.organizationRecipients.mockResolvedValue([
                'target',
                'owner',
                'admin',
                'actor',
            ]);
            await service.updateRole('org', 'target', 'actor', { role: after });
            expect(notifications.organizationRecipients).toHaveBeenCalledWith(
                'org',
                tx,
                ['OWNER', 'ADMIN'],
            );
            expect(event().recipients).toEqual([
                { userId: 'target', email: true },
                'target',
                'owner',
                'admin',
                'actor',
            ]);
            expect(event().actorId).toBe('actor');
            expect(event().includeActor).not.toBe(true);
            expect(event().meta).toEqual({ oldRole: before, newRole: after });
            expect(
                tx.membership.updateMany.mock.invocationCallOrder[0],
            ).toBeLessThan(
                notifications.organizationRecipients.mock
                    .invocationCallOrder[0],
            );
        },
    );

    it.each([
        ['owner-target', 'OWNER', 'VIEWER', 'actor', ForbiddenException],
        ['owner-promotion', 'MEMBER', 'OWNER', 'actor', BadRequestException],
        ['self-change', 'MEMBER', 'VIEWER', 'target', BadRequestException],
    ] as const)(
        'does not mutate or notify prohibited role updates: %s',
        async (_reason, before, after, actor, error) => {
            const { service, prisma, tx, notifications } = await setup(before);
            await expect(
                service.updateRole('org', 'target', actor, { role: after }),
            ).rejects.toThrow(error);
            expect(prisma.$transaction).not.toHaveBeenCalled();
            expect(tx.membership.updateMany).not.toHaveBeenCalled();
            expect(notifications.publish).not.toHaveBeenCalled();
        },
    );

    it('deletes membership and publishes removed-user and admin notices in the same transaction', async () => {
        const { service, tx, notifications, event } = await setup();
        await service.removeMember('org', 'target', 'actor');
        expect(tx.membership.delete).toHaveBeenCalledWith({
            where: { id: 'membership' },
        });
        expect(event()).toMatchObject({
            eventKey: 'member-removed:membership',
            type: 'MEMBER_REMOVED',
            actorId: 'actor',
            organizationId: 'org',
            resourceType: 'Organization',
            resourceId: 'org',
            allowOutsideOrg: true,
            recipients: [{ userId: 'target', email: true }],
        });
        expect(event(1)).toMatchObject({
            eventKey: 'member-removed-admin:membership',
            type: 'MEMBER_REMOVED',
            actorId: 'actor',
            organizationId: 'org',
            recipients: ['owner', 'admin', 'actor'],
            meta: { memberId: 'target' },
        });
        expect(event(1).allowOutsideOrg).not.toBe(true);
        expect(event(1).includeActor).not.toBe(true);
        expect(notifications.organizationRecipients).toHaveBeenCalledWith(
            'org',
            tx,
            ['OWNER', 'ADMIN'],
        );
        expect(tx.membership.delete.mock.invocationCallOrder[0]).toBeLessThan(
            notifications.publish.mock.invocationCallOrder[0],
        );
        expect(tx.membership.delete.mock.invocationCallOrder[0]).toBeLessThan(
            notifications.organizationRecipients.mock.invocationCallOrder[0],
        );
    });

    it.each([
        ['OWNER', 'actor', ForbiddenException],
        ['MEMBER', 'target', BadRequestException],
    ] as const)(
        'does not remove or notify prohibited removals for %s by %s',
        async (role, actor, error) => {
            const { service, prisma, tx, notifications } = await setup(role);
            await expect(
                service.removeMember('org', 'target', actor),
            ).rejects.toThrow(error);
            expect(prisma.$transaction).not.toHaveBeenCalled();
            expect(tx.membership.delete).not.toHaveBeenCalled();
            expect(notifications.publish).not.toHaveBeenCalled();
        },
    );

    it('notifies only current admins when a member leaves, excluding the actor through the core contract', async () => {
        const { service, tx, notifications, event } = await setup();
        notifications.organizationRecipients.mockResolvedValue([
            'owner',
            'admin',
            'target',
        ]);
        await service.leaveOrganization('org', 'target');
        expect(tx.membership.delete).toHaveBeenCalledWith({
            where: { id: 'membership' },
        });
        expect(notifications.organizationRecipients).toHaveBeenCalledWith(
            'org',
            tx,
            ['OWNER', 'ADMIN'],
        );
        expect(notifications.publish).toHaveBeenCalledTimes(1);
        expect(event()).toMatchObject({
            eventKey: 'member-left:membership',
            type: 'MEMBER_LEFT',
            actorId: 'target',
            organizationId: 'org',
            recipients: ['owner', 'admin', 'target'],
            meta: { memberId: 'target' },
        });
        expect(event().includeActor).not.toBe(true);
        expect(event().allowOutsideOrg).not.toBe(true);
        expect(event().email).not.toBe(true);
        expect(tx.membership.delete.mock.invocationCallOrder[0]).toBeLessThan(
            notifications.publish.mock.invocationCallOrder[0],
        );
    });

    it('does not allow the owner to leave or publish a departure notice', async () => {
        const { service, prisma, tx, notifications } = await setup('OWNER');
        await expect(
            service.leaveOrganization('org', 'target'),
        ).rejects.toThrow(ForbiddenException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(tx.membership.delete).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it.each(['updateRole', 'removeMember', 'leaveOrganization'] as const)(
        'does not mutate or notify a missing membership for %s',
        async (method) => {
            const { service, prisma, tx, notifications } = await setup();
            prisma.membership.findUnique.mockResolvedValue(null);
            const operation =
                method === 'updateRole'
                    ? service.updateRole('org', 'target', 'actor', {
                          role: 'VIEWER',
                      })
                    : method === 'removeMember'
                      ? service.removeMember('org', 'target', 'actor')
                      : service.leaveOrganization('org', 'target');
            await expect(operation).rejects.toThrow(NotFoundException);
            expect(tx.membership.updateMany).not.toHaveBeenCalled();
            expect(tx.membership.delete).not.toHaveBeenCalled();
            expect(notifications.publish).not.toHaveBeenCalled();
        },
    );

    it.each(['updateRole', 'removeMember', 'leaveOrganization'] as const)(
        'propagates delivery persistence failures through the %s transaction',
        async (method) => {
            const { service, notifications } = await setup();
            notifications.publish.mockRejectedValue(
                new Error('Outbox unavailable'),
            );
            const operation =
                method === 'updateRole'
                    ? service.updateRole('org', 'target', 'actor', {
                          role: 'VIEWER',
                      })
                    : method === 'removeMember'
                      ? service.removeMember('org', 'target', 'actor')
                      : service.leaveOrganization('org', 'target');
            await expect(operation).rejects.toThrow('Outbox unavailable');
        },
    );
});
