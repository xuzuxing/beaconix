import { Test } from '@nestjs/testing';
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { QuotaService } from '../../shared/quota/quota.service';
import { InvitationStatus, MembershipRole } from '../../generated/prisma/enums';
import { NotificationsService } from '../notifications/notifications.service';
import type { NotificationEvent } from '../notifications/notification-event';
import { EmailTemplate } from '../email/email.types';
import { InvitationsService } from './invitations.service';

const now = new Date('2026-10-11T08:00:00.000Z');
const org = { id: 'org', name: 'Beacon', slug: 'beacon', deletedAt: null };
const invitee = {
    id: 'invitee',
    email: 'invitee@example.com',
    name: 'Invitee',
};
const invitationRow = {
    id: 'invitation',
    organizationId: 'org',
    email: 'invitee@example.com',
    role: MembershipRole.MEMBER,
    status: InvitationStatus.PENDING,
    token: 'test-invitation-token',
    sentById: 'sender',
    expiresAt: new Date('2026-10-18T08:00:00.000Z'),
    acceptedAt: null as Date | null,
    createdAt: now,
    updatedAt: now,
    organization: org,
    sentBy: { id: 'sender', name: 'Sender', email: 'sender@example.com' },
};

async function setup(overrides: Partial<typeof invitationRow> = {}) {
    const invitation = { ...invitationRow, ...overrides };
    let inTransaction = false;
    const tx = {
        organization: { findFirst: jest.fn().mockResolvedValue(org) },
        membership: {
            findFirst: jest.fn().mockResolvedValue(null),
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: 'membership' }),
        },
        invitation: {
            findFirst: jest.fn().mockResolvedValue(null),
            findUnique: jest.fn().mockResolvedValue(invitation),
            findUniqueOrThrow: jest.fn().mockResolvedValue({
                ...invitation,
                status: InvitationStatus.ACCEPTED,
                acceptedAt: now,
            }),
            create: jest.fn().mockResolvedValue(invitation),
            delete: jest.fn().mockResolvedValue(invitation),
            update: jest.fn().mockResolvedValue({
                ...invitation,
                status: InvitationStatus.EXPIRED,
            }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        user: { findFirst: jest.fn().mockResolvedValue(invitee) },
        notification: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
        invitation: {
            findUnique: jest.fn().mockResolvedValue(invitation),
            findMany: jest.fn().mockResolvedValue([]),
        },
        user: { findFirst: jest.fn().mockResolvedValue(invitee) },
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
        publish: jest.fn().mockImplementation((_event, client) => {
            expect(inTransaction).toBe(true);
            expect(client).toBe(tx);
            return Promise.resolve();
        }),
        enqueueEmail: jest
            .fn()
            .mockImplementation((_template, _payload, _key, client) => {
                expect(inTransaction).toBe(true);
                expect(client).toBe(tx);
                return Promise.resolve();
            }),
        organizationRecipients: jest.fn().mockResolvedValue(['owner', 'admin']),
        syncPendingInvitations: jest.fn().mockResolvedValue(undefined),
    };
    const quota = {
        assertCanCreate: jest.fn().mockImplementation(() => {
            expect(inTransaction).toBe(true);
            return Promise.resolve();
        }),
    };
    const moduleRef = await Test.createTestingModule({
        providers: [
            InvitationsService,
            { provide: PrismaService, useValue: prisma },
            { provide: NotificationsService, useValue: notifications },
            { provide: QuotaService, useValue: quota },
        ],
    }).compile();
    return {
        service: moduleRef.get(InvitationsService),
        prisma,
        tx,
        notifications,
        quota,
        invitation,
        event: (index = 0) =>
            notifications.publish.mock.calls[index][0] as NotificationEvent,
    };
}

describe('InvitationsService collaboration notifications', () => {
    beforeEach(() => {
        jest.useFakeTimers().setSystemTime(now);
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    it('creates the invitation, station notification and durable email in the same transaction', async () => {
        const { service, tx, notifications, event } = await setup();
        const result = await service.send('org', 'sender', {
            email: ' Invitee@Example.COM ',
        });
        expect(result.id).toBe('invitation');
        expect(tx.organization.findFirst).toHaveBeenCalledWith({
            where: { id: 'org', deletedAt: null },
        });
        expect(tx.invitation.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: {
                    email: 'invitee@example.com',
                    organizationId: 'org',
                    role: 'MEMBER',
                    sentById: 'sender',
                    expiresAt: invitationRow.expiresAt,
                },
            }),
        );
        expect(tx.user.findFirst).toHaveBeenCalledWith({
            where: {
                email: { equals: 'invitee@example.com', mode: 'insensitive' },
                deletedAt: null,
                isActive: true,
                emailVerified: true,
            },
            select: { id: true },
        });
        expect(event()).toMatchObject({
            eventKey: 'invitation-received:invitation',
            type: 'INVITATION_RECEIVED',
            actorId: 'sender',
            organizationId: 'org',
            allowOutsideOrg: true,
            resourceType: 'Invitation',
            resourceId: 'invitation',
            recipients: ['invitee'],
            meta: {
                invitationStatus: 'PENDING',
                invitationExpiresAt: invitationRow.expiresAt.toISOString(),
                actionable: true,
            },
        });
        expect(JSON.stringify(event())).not.toContain(invitationRow.token);
        expect(notifications.enqueueEmail).toHaveBeenCalledWith(
            EmailTemplate.INVITATION,
            {
                to: 'invitee@example.com',
                orgName: 'Beacon',
                token: invitationRow.token,
                inviterName: 'Sender',
            },
            'invitation:invitation',
            tx,
        );
        expect(tx.invitation.create.mock.invocationCallOrder[0]).toBeLessThan(
            notifications.publish.mock.invocationCallOrder[0],
        );
    });

    it('emails an invitee without publishing a station notice unless a verified active account exists', async () => {
        const { service, tx, notifications } = await setup();
        tx.user.findFirst.mockResolvedValue(null);
        await service.send('org', 'sender', { email: invitee.email });
        expect(notifications.publish).not.toHaveBeenCalled();
        expect(notifications.enqueueEmail).toHaveBeenCalledTimes(1);
    });

    it('claims an expired pending invitation before notifying, deleting and replacing it', async () => {
        const { service, tx, notifications, event } = await setup();
        tx.invitation.findFirst.mockResolvedValue({
            ...invitationRow,
            id: 'old-invitation',
            expiresAt: now,
        });
        await service.send('org', 'sender', { email: invitee.email });
        expect(tx.invitation.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'old-invitation',
                status: 'PENDING',
                expiresAt: { lte: now },
            },
            data: { status: 'EXPIRED' },
        });
        expect(event()).toMatchObject({
            type: 'INVITATION_EXPIRED',
            resourceId: 'old-invitation',
            meta: { invitationStatus: 'EXPIRED', actionable: false },
        });
        expect(event(1)).toMatchObject({
            type: 'INVITATION_RECEIVED',
            resourceId: 'invitation',
        });
        expect(tx.invitation.delete).toHaveBeenCalledWith({
            where: { id: 'old-invitation' },
        });
        expect(
            tx.invitation.updateMany.mock.invocationCallOrder[0],
        ).toBeLessThan(notifications.publish.mock.invocationCallOrder[0]);
        expect(notifications.publish.mock.invocationCallOrder[0]).toBeLessThan(
            tx.invitation.delete.mock.invocationCallOrder[0],
        );
        expect(tx.invitation.delete.mock.invocationCallOrder[0]).toBeLessThan(
            tx.invitation.create.mock.invocationCallOrder[0],
        );
        expect(notifications.enqueueEmail).toHaveBeenCalledTimes(1);
    });

    it('does not expire, delete or replace a stale pending invitation when concurrent revocation wins', async () => {
        const { service, tx, notifications } = await setup();
        tx.invitation.findFirst.mockResolvedValue({
            ...invitationRow,
            id: 'old-invitation',
            status: InvitationStatus.PENDING,
            expiresAt: now,
        });
        tx.invitation.updateMany.mockResolvedValue({ count: 0 });
        await expect(
            service.send('org', 'sender', { email: invitee.email }),
        ).rejects.toThrow(
            new ConflictException(
                'Invitation was already processed; retry the request',
            ),
        );
        expect(tx.invitation.updateMany).toHaveBeenCalledTimes(1);
        expect(tx.invitation.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'old-invitation',
                status: 'PENDING',
                expiresAt: { lte: now },
            },
            data: { status: 'EXPIRED' },
        });
        expect(tx.notification.updateMany).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
        expect(tx.invitation.delete).not.toHaveBeenCalled();
        expect(tx.invitation.create).not.toHaveBeenCalled();
        expect(notifications.enqueueEmail).not.toHaveBeenCalled();
    });

    it('rejects invitations granting OWNER before mutation or delivery', async () => {
        const { service, prisma, notifications } = await setup();
        await expect(
            service.send('org', 'sender', {
                email: invitee.email,
                role: 'OWNER',
            }),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(notifications.enqueueEmail).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it.each(['missing-org', 'existing-member', 'pending-invitation'])(
        'does not deliver rejected sends: %s',
        async (reason) => {
            const { service, tx, notifications } = await setup();
            if (reason === 'missing-org')
                tx.organization.findFirst.mockResolvedValue(null);
            if (reason === 'existing-member')
                tx.membership.findFirst.mockResolvedValue({ id: 'member' });
            if (reason === 'pending-invitation')
                tx.invitation.findFirst.mockResolvedValue(invitationRow);
            await expect(
                service.send('org', 'sender', { email: invitee.email }),
            ).rejects.toThrow();
            expect(tx.invitation.create).not.toHaveBeenCalled();
            expect(notifications.publish).not.toHaveBeenCalled();
            expect(notifications.enqueueEmail).not.toHaveBeenCalled();
        },
    );

    it.each(['publish', 'enqueueEmail'] as const)(
        'propagates %s failures through the invitation send transaction',
        async (method) => {
            const { service, notifications } = await setup();
            notifications[method].mockRejectedValue(
                new Error('Outbox unavailable'),
            );
            await expect(
                service.send('org', 'sender', { email: invitee.email }),
            ).rejects.toThrow('Outbox unavailable');
        },
    );

    it.each(['getById', 'acceptById', 'declineById'] as const)(
        'requires verified, active email ownership for %s',
        async (method) => {
            const { service, prisma, tx, notifications } = await setup();
            prisma.user.findFirst.mockResolvedValue(null);
            tx.user.findFirst.mockResolvedValue(null);
            await expect(
                service[method]('invitation', 'invitee'),
            ).rejects.toThrow(ForbiddenException);
            const db = method === 'getById' ? prisma : tx;
            expect(db.user.findFirst).toHaveBeenCalledWith({
                where: {
                    id: 'invitee',
                    deletedAt: null,
                    isActive: true,
                    emailVerified: true,
                },
                select: { email: true, name: true },
            });
            expect(tx.invitation.updateMany).not.toHaveBeenCalled();
            expect(notifications.publish).not.toHaveBeenCalled();
        },
    );

    it.each(['getById', 'acceptById', 'declineById'] as const)(
        'rejects a verified user who owns a different email for %s',
        async (method) => {
            const { service, prisma, tx, notifications } = await setup();
            const otherUser = { ...invitee, email: 'other@example.com' };
            prisma.user.findFirst.mockResolvedValue(otherUser);
            tx.user.findFirst.mockResolvedValue(otherUser);
            await expect(
                service[method]('invitation', 'invitee'),
            ).rejects.toThrow('belongs to another email');
            expect(tx.membership.create).not.toHaveBeenCalled();
            expect(notifications.publish).not.toHaveBeenCalled();
        },
    );

    it('matches invitee email case-insensitively and returns only owned invitations', async () => {
        const { service, prisma } = await setup({
            email: ' Invitee@EXAMPLE.COM ',
        });
        await expect(
            service.getById('invitation', 'invitee'),
        ).resolves.toMatchObject({ id: 'invitation' });
        expect(prisma.invitation.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'invitation' },
            }),
        );
    });

    it.each(['accept', 'decline'] as const)(
        'resolves the token and retains verified-email ownership checks for %s',
        async (method) => {
            const { service, prisma, tx, notifications } = await setup();
            tx.user.findFirst.mockResolvedValue({
                ...invitee,
                email: 'different@example.com',
            });
            await expect(
                service[method](invitationRow.token, 'invitee'),
            ).rejects.toThrow(ForbiddenException);
            expect(prisma.invitation.findUnique).toHaveBeenCalledWith({
                where: { token: invitationRow.token },
                select: { id: true },
            });
            expect(tx.invitation.findUnique).toHaveBeenCalledWith(
                expect.objectContaining({ where: { id: 'invitation' } }),
            );
            expect(tx.membership.create).not.toHaveBeenCalled();
            expect(tx.invitation.updateMany).not.toHaveBeenCalled();
            expect(notifications.publish).not.toHaveBeenCalled();
        },
    );

    it.each(['getById', 'acceptById', 'declineById'] as const)(
        'hides invitations belonging to deleted organizations for %s',
        async (method) => {
            const { service, prisma, tx, notifications } = await setup();
            const hidden = {
                ...invitationRow,
                organization: { ...org, deletedAt: now },
            };
            prisma.invitation.findUnique.mockResolvedValue(hidden);
            tx.invitation.findUnique.mockResolvedValue(hidden);
            await expect(
                service[method]('invitation', 'invitee'),
            ).rejects.toThrow(NotFoundException);
            expect(notifications.publish).not.toHaveBeenCalled();
        },
    );

    it('discovers pending invitations only after verified-email authorization', async () => {
        const { service, prisma, notifications } = await setup();
        prisma.invitation.findMany.mockResolvedValue([invitationRow]);
        await service.findPendingForUser('invitee');
        expect(notifications.syncPendingInvitations).toHaveBeenCalledWith(
            'invitee',
        );
        expect(prisma.invitation.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    email: { equals: invitee.email, mode: 'insensitive' },
                    status: 'PENDING',
                    expiresAt: { gt: now },
                    organization: { deletedAt: null },
                },
            }),
        );
    });

    it('does not synchronize or list invitations for an unverified user', async () => {
        const { service, prisma, notifications } = await setup();
        prisma.user.findFirst.mockResolvedValue(null);
        await expect(service.findPendingForUser('invitee')).rejects.toThrow(
            ForbiddenException,
        );
        expect(notifications.syncPendingInvitations).not.toHaveBeenCalled();
        expect(prisma.invitation.findMany).not.toHaveBeenCalled();
    });

    it('claims acceptance before membership creation and durably sends acceptance and welcome', async () => {
        const { service, tx, quota, notifications, event } = await setup();
        await expect(
            service.acceptById('invitation', 'invitee'),
        ).resolves.toMatchObject({ status: 'ACCEPTED' });
        expect(quota.assertCanCreate).toHaveBeenCalledWith('org', 'members');
        expect(tx.invitation.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'invitation',
                status: 'PENDING',
                expiresAt: { gt: now },
            },
            data: { status: 'ACCEPTED', acceptedAt: now },
        });
        expect(tx.membership.create).toHaveBeenCalledWith({
            data: {
                userId: 'invitee',
                organizationId: 'org',
                role: 'MEMBER',
                invitedById: 'sender',
            },
        });
        expect(
            tx.invitation.updateMany.mock.invocationCallOrder[0],
        ).toBeLessThan(tx.membership.create.mock.invocationCallOrder[0]);
        expect(notifications.organizationRecipients).toHaveBeenCalledWith(
            'org',
            tx,
            ['OWNER', 'ADMIN'],
        );
        expect(event()).toMatchObject({
            eventKey: 'invitation:invitation:ACCEPTED',
            type: 'INVITATION_ACCEPTED',
            actorId: 'invitee',
            includeActor: true,
            allowOutsideOrg: true,
            recipients: [
                {
                    userId: 'invitee',
                    type: 'MEMBER_JOINED',
                    title: 'You joined Beacon',
                },
                'sender',
                'owner',
                'admin',
            ],
            meta: { invitationStatus: 'ACCEPTED', actionable: false },
        });
        expect(tx.notification.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { resourceType: 'Invitation', resourceId: 'invitation' },
                data: {
                    meta: expect.objectContaining({
                        invitationStatus: 'ACCEPTED',
                        actionable: false,
                    }),
                },
            }),
        );
        expect(notifications.enqueueEmail).toHaveBeenCalledWith(
            EmailTemplate.WELCOME,
            { to: invitee.email, name: invitee.name, orgName: 'Beacon' },
            'invitation-welcome:invitation',
            tx,
            { userId: 'invitee', organizationId: 'org' },
        );
        expect(JSON.stringify(event())).not.toContain(invitationRow.token);
    });

    it('does not create membership or deliver welcome when an acceptance claim loses', async () => {
        const { service, tx, notifications } = await setup();
        tx.invitation.updateMany.mockResolvedValue({ count: 0 });
        await expect(
            service.acceptById('invitation', 'invitee'),
        ).rejects.toThrow(ConflictException);
        expect(tx.membership.create).not.toHaveBeenCalled();
        expect(tx.notification.updateMany).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
        expect(notifications.enqueueEmail).not.toHaveBeenCalled();
    });

    it.each(['existing-member', 'quota', 'owner-role', 'already-accepted'])(
        'does not claim or deliver rejected acceptance: %s',
        async (reason) => {
            const { service, tx, quota, notifications } = await setup();
            if (reason === 'existing-member')
                tx.membership.findUnique.mockResolvedValue({
                    id: 'membership',
                });
            if (reason === 'quota')
                quota.assertCanCreate.mockRejectedValue(
                    new ForbiddenException('Quota exceeded'),
                );
            if (reason === 'owner-role')
                tx.invitation.findUnique.mockResolvedValue({
                    ...invitationRow,
                    role: 'OWNER',
                });
            if (reason === 'already-accepted')
                tx.invitation.findUnique.mockResolvedValue({
                    ...invitationRow,
                    status: 'ACCEPTED',
                });
            await expect(
                service.acceptById('invitation', 'invitee'),
            ).rejects.toThrow();
            expect(tx.invitation.updateMany).not.toHaveBeenCalled();
            expect(tx.membership.create).not.toHaveBeenCalled();
            expect(notifications.publish).not.toHaveBeenCalled();
            expect(notifications.enqueueEmail).not.toHaveBeenCalled();
        },
    );

    it('conditionally expires an expired acceptance attempt without creating membership or welcome', async () => {
        const { service, prisma, tx, notifications, event } = await setup({
            expiresAt: now,
        });
        await expect(
            service.acceptById('invitation', 'invitee'),
        ).rejects.toThrow('has expired');
        expect(tx.invitation.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'invitation',
                status: 'PENDING',
                expiresAt: { lte: now },
            },
            data: { status: 'EXPIRED' },
        });
        expect(tx.invitation.update).not.toHaveBeenCalled();
        expect(event()).toMatchObject({
            type: 'INVITATION_EXPIRED',
            recipients: ['sender'],
            meta: { invitationStatus: 'EXPIRED', actionable: false },
        });
        expect(tx.membership.create).not.toHaveBeenCalled();
        expect(notifications.enqueueEmail).not.toHaveBeenCalled();
        await expect(
            prisma.$transaction.mock.results[0].value,
        ).resolves.toBeNull();
    });

    it('does not overwrite or notify an expired acceptance attempt when another transition won', async () => {
        const { service, tx, notifications } = await setup({ expiresAt: now });
        tx.invitation.updateMany.mockResolvedValue({ count: 0 });
        await expect(
            service.acceptById('invitation', 'invitee'),
        ).rejects.toThrow();
        expect(tx.invitation.update).not.toHaveBeenCalled();
        expect(tx.notification.updateMany).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
        expect(tx.membership.create).not.toHaveBeenCalled();
        expect(notifications.enqueueEmail).not.toHaveBeenCalled();
    });

    it('conditionally claims decline and notifies the original sender in the same transaction', async () => {
        const { service, tx, notifications, event } = await setup();
        await expect(
            service.declineById('invitation', 'invitee'),
        ).resolves.toMatchObject({ status: 'DECLINED' });
        expect(tx.invitation.updateMany).toHaveBeenCalledWith({
            where: { id: 'invitation', status: 'PENDING' },
            data: { status: 'DECLINED' },
        });
        expect(event()).toMatchObject({
            eventKey: 'invitation:invitation:DECLINED',
            type: 'INVITATION_DECLINED',
            actorId: 'invitee',
            recipients: ['sender'],
            meta: { invitationStatus: 'DECLINED', actionable: false },
        });
        expect(notifications.organizationRecipients).not.toHaveBeenCalled();
        expect(notifications.enqueueEmail).not.toHaveBeenCalled();
    });

    it('expires an already expired decline instead of issuing a decline notice', async () => {
        const { service, tx, event } = await setup({ expiresAt: now });
        await expect(
            service.declineById('invitation', 'invitee'),
        ).rejects.toThrow('has expired');
        expect(tx.invitation.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: 'invitation',
                    status: 'PENDING',
                }),
                data: { status: 'EXPIRED' },
            }),
        );
        expect(event().type).toBe('INVITATION_EXPIRED');
    });

    it('does not deliver decline after losing its pending-state claim', async () => {
        const { service, tx, notifications } = await setup();
        tx.invitation.updateMany.mockResolvedValue({ count: 0 });
        await expect(
            service.declineById('invitation', 'invitee'),
        ).rejects.toThrow(ConflictException);
        expect(tx.notification.updateMany).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it('conditionally revokes an org-scoped invitation and notifies its verified invitee', async () => {
        const { service, tx, event } = await setup();
        tx.invitation.findFirst.mockResolvedValue(invitationRow);
        await expect(
            service.revoke('org', 'invitation', 'actor'),
        ).resolves.toMatchObject({ status: 'REVOKED' });
        expect(tx.invitation.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'invitation', organizationId: 'org' },
            }),
        );
        expect(tx.invitation.updateMany).toHaveBeenCalledWith({
            where: { id: 'invitation', status: 'PENDING' },
            data: { status: 'REVOKED' },
        });
        expect(event()).toMatchObject({
            type: 'INVITATION_REVOKED',
            actorId: 'actor',
            allowOutsideOrg: true,
            recipients: ['invitee'],
            meta: { invitationStatus: 'REVOKED', actionable: false },
        });
        expect(tx.user.findFirst).toHaveBeenCalledWith({
            where: {
                email: { equals: invitee.email, mode: 'insensitive' },
                deletedAt: null,
                isActive: true,
                emailVerified: true,
            },
            select: { id: true },
        });
    });

    it('does not notify a revoke after its conditional claim loses', async () => {
        const { service, tx, notifications } = await setup();
        tx.invitation.findFirst.mockResolvedValue(invitationRow);
        tx.invitation.updateMany.mockResolvedValue({ count: 0 });
        await expect(
            service.revoke('org', 'invitation', 'actor'),
        ).rejects.toThrow(BadRequestException);
        expect(tx.notification.updateMany).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it('does not claim a revoke for a missing or cross-org invitation', async () => {
        const { service, tx, notifications } = await setup();
        await expect(
            service.revoke('other-org', 'invitation', 'actor'),
        ).rejects.toThrow(NotFoundException);
        expect(tx.invitation.updateMany).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it('conditionally claims expiry and durably updates existing station metadata', async () => {
        const { service, prisma, tx, notifications, event } = await setup();
        prisma.invitation.findMany.mockResolvedValueOnce([
            { ...invitationRow, expiresAt: now },
        ]);
        await expect(service.expirePending()).resolves.toBe(1);
        expect(prisma.invitation.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { status: 'PENDING', expiresAt: { lte: now } },
            }),
        );
        expect(tx.invitation.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'invitation',
                status: 'PENDING',
                expiresAt: { lte: now },
            },
            data: { status: 'EXPIRED' },
        });
        expect(event()).toMatchObject({
            eventKey: 'invitation:invitation:EXPIRED',
            type: 'INVITATION_EXPIRED',
            recipients: ['sender'],
            meta: { invitationStatus: 'EXPIRED', actionable: false },
        });
        expect(tx.notification.updateMany).toHaveBeenCalledTimes(1);
        expect(notifications.enqueueEmail).not.toHaveBeenCalled();
    });

    it('does not count or deliver an expiry claim another replica has already processed', async () => {
        const { service, prisma, tx, notifications } = await setup();
        prisma.invitation.findMany.mockResolvedValueOnce([
            { ...invitationRow, expiresAt: now },
        ]);
        tx.invitation.updateMany.mockResolvedValue({ count: 0 });
        await expect(service.expirePending()).resolves.toBe(0);
        expect(tx.notification.updateMany).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it('drains expired invitations beyond the first 200-row batch', async () => {
        const { service, prisma, tx, notifications } = await setup();
        const firstBatch = Array.from({ length: 200 }, (_, i) => ({
            ...invitationRow,
            id: `expired-${i}`,
            expiresAt: now,
        }));
        prisma.invitation.findMany
            .mockResolvedValueOnce(firstBatch)
            .mockResolvedValueOnce([
                { ...invitationRow, id: 'expired-200', expiresAt: now },
            ]);
        await expect(service.expirePending()).resolves.toBe(201);
        expect(
            prisma.invitation.findMany.mock.calls.length,
        ).toBeGreaterThanOrEqual(2);
        expect(tx.invitation.updateMany).toHaveBeenCalledTimes(201);
        expect(notifications.publish).toHaveBeenCalledTimes(201);
    });

    it('advances past a full batch of lost expiry claims and counts only winning transitions', async () => {
        const { service, prisma, tx, notifications, event } = await setup();
        const firstBatch = Array.from({ length: 200 }, (_, i) => ({
            ...invitationRow,
            id: `expired-${String(i).padStart(3, '0')}`,
            expiresAt: now,
        }));
        prisma.invitation.findMany
            .mockResolvedValueOnce(firstBatch)
            .mockResolvedValueOnce([
                {
                    ...invitationRow,
                    id: 'expired-200',
                    expiresAt: now,
                },
            ]);
        tx.invitation.updateMany.mockImplementation(({ where }) =>
            Promise.resolve({ count: where.id === 'expired-200' ? 1 : 0 }),
        );
        await expect(service.expirePending()).resolves.toBe(1);
        expect(prisma.invitation.findMany.mock.calls[1][0]).toMatchObject({
            where: { id: { gt: 'expired-199' } },
            orderBy: { id: 'asc' },
        });
        expect(tx.notification.updateMany).toHaveBeenCalledTimes(1);
        expect(notifications.publish).toHaveBeenCalledTimes(1);
        expect(event().resourceId).toBe('expired-200');
    });

    it.each(['acceptById', 'declineById', 'revoke', 'expirePending'] as const)(
        'does not swallow publication failure inside the %s transaction',
        async (method) => {
            const { service, prisma, tx, notifications } = await setup();
            notifications.publish.mockRejectedValue(
                new Error('Outbox unavailable'),
            );
            tx.invitation.findFirst.mockResolvedValue(invitationRow);
            prisma.invitation.findMany.mockResolvedValueOnce([
                { ...invitationRow, expiresAt: now },
            ]);
            const operation =
                method === 'revoke'
                    ? service.revoke('org', 'invitation', 'actor')
                    : method === 'expirePending'
                      ? service.expirePending()
                      : service[method]('invitation', 'invitee');
            await expect(operation).rejects.toThrow('Outbox unavailable');
        },
    );
});
