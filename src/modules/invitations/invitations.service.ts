import {
    Injectable,
    NotFoundException,
    BadRequestException,
    ConflictException,
    ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { QuotaService } from '../../shared/quota/quota.service';
import { Prisma } from '../../generated/prisma/client';
import { InvitationStatus } from '../../generated/prisma/enums';
import { CreateInvitationDto } from './dto';
import { InvitationEntity } from './entities';
import { NotificationsService } from '../notifications/notifications.service';
import {
    ADMIN_ROLES,
    NotificationDb,
} from '../notifications/notification-event';
import { EmailTemplate } from '../email/email.types';

const invitationInclude = {
    organization: {
        select: { id: true, name: true, slug: true, deletedAt: true },
    },
    sentBy: { select: { id: true, name: true, email: true } },
} as const;
type Invitation = Prisma.InvitationGetPayload<{
    include: typeof invitationInclude;
}>;

@Injectable()
export class InvitationsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly notificationsService: NotificationsService,
        private readonly quotaService: QuotaService,
    ) {}

    async send(orgId: string, senderId: string, dto: CreateInvitationDto) {
        if (dto.role === 'OWNER')
            throw new BadRequestException('An invitation cannot assign OWNER');
        const email = dto.email.trim().toLowerCase();
        try {
            const invitation = await this.prisma.$transaction(async (tx) => {
                const org = await tx.organization.findFirst({
                    where: { id: orgId, deletedAt: null },
                });
                if (!org) throw new NotFoundException('Organization not found');
                const existingMember = await tx.membership.findFirst({
                    where: {
                        organizationId: orgId,
                        user: { email: { equals: email, mode: 'insensitive' } },
                    },
                });
                if (existingMember)
                    throw new ConflictException(
                        'User is already a member of this organization',
                    );
                const existing = await tx.invitation.findFirst({
                    where: {
                        email: { equals: email, mode: 'insensitive' },
                        organizationId: orgId,
                    },
                    include: invitationInclude,
                });
                if (
                    existing?.status === 'PENDING' &&
                    existing.expiresAt > new Date()
                ) {
                    throw new ConflictException(
                        'A pending invitation already exists for this email',
                    );
                }
                if (existing) {
                    if (existing.status === 'PENDING') {
                        const claimed = await tx.invitation.updateMany({
                            where: {
                                id: existing.id,
                                status: 'PENDING',
                                expiresAt: { lte: new Date() },
                            },
                            data: { status: 'EXPIRED' },
                        });
                        if (!claimed.count)
                            throw new ConflictException(
                                'Invitation was already processed; retry the request',
                            );
                        await this.notifyTransition(
                            { ...existing, status: 'EXPIRED' },
                            tx,
                        );
                    }
                    await tx.invitation.delete({ where: { id: existing.id } });
                }
                const created = await tx.invitation.create({
                    data: {
                        email,
                        organizationId: orgId,
                        role: dto.role ?? 'MEMBER',
                        sentById: senderId,
                        expiresAt: new Date(Date.now() + 7 * 86400_000),
                    },
                    include: invitationInclude,
                });
                const user = await tx.user.findFirst({
                    where: {
                        email: { equals: email, mode: 'insensitive' },
                        deletedAt: null,
                        isActive: true,
                        emailVerified: true,
                    },
                    select: { id: true },
                });
                if (user)
                    await this.notificationsService.publish(
                        {
                            eventKey: `invitation-received:${created.id}`,
                            recipients: [user.id],
                            type: 'INVITATION_RECEIVED',
                            title: `You are invited to join ${org.name}`,
                            body: `${created.sentBy.name} invited you as ${created.role}.`,
                            organizationId: orgId,
                            allowOutsideOrg: true,
                            actorId: senderId,
                            resourceType: 'Invitation',
                            resourceId: created.id,
                            meta: {
                                invitationStatus: 'PENDING',
                                invitationExpiresAt:
                                    created.expiresAt.toISOString(),
                                actionable: true,
                            },
                        },
                        tx,
                    );
                await this.notificationsService.enqueueEmail(
                    EmailTemplate.INVITATION,
                    {
                        to: email,
                        orgName: org.name,
                        token: created.token,
                        inviterName: created.sentBy.name,
                    },
                    `invitation:${created.id}`,
                    tx,
                );
                return created;
            });
            return new InvitationEntity(invitation);
        } catch (error) {
            if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002'
            ) {
                throw new ConflictException(
                    'A pending invitation already exists for this email',
                );
            }
            throw error;
        }
    }

    async findAllForOrg(orgId: string) {
        const invitations = await this.prisma.invitation.findMany({
            where: { organizationId: orgId },
            include: invitationInclude,
            orderBy: { createdAt: 'desc' },
        });
        return invitations.map(
            (invitation) => new InvitationEntity(invitation),
        );
    }

    async findPendingForUser(userId: string) {
        const user = await this.assertVerifiedUser(userId, this.prisma);
        await this.notificationsService.syncPendingInvitations(userId);
        const invitations = await this.prisma.invitation.findMany({
            where: {
                email: { equals: user.email, mode: 'insensitive' },
                status: 'PENDING',
                expiresAt: { gt: new Date() },
                organization: { deletedAt: null },
            },
            include: invitationInclude,
            orderBy: { createdAt: 'desc' },
        });
        return invitations.map(
            (invitation) => new InvitationEntity(invitation),
        );
    }

    async getById(id: string, userId: string) {
        const invitation = await this.prisma.invitation.findUnique({
            where: { id },
            include: invitationInclude,
        });
        if (!invitation || invitation.organization.deletedAt)
            throw new NotFoundException('Invitation not found');
        await this.assertInvitee(invitation, userId, this.prisma);
        return new InvitationEntity(invitation);
    }

    async getByToken(token: string) {
        const invitation = await this.prisma.invitation.findUnique({
            where: { token },
            include: invitationInclude,
        });
        if (!invitation || invitation.organization.deletedAt)
            throw new NotFoundException('Invitation not found');
        return new InvitationEntity(invitation);
    }

    async revoke(orgId: string, invitationId: string, actorId?: string) {
        const updated = await this.prisma.$transaction(async (tx) => {
            const invitation = await tx.invitation.findFirst({
                where: { id: invitationId, organizationId: orgId },
                include: invitationInclude,
            });
            if (!invitation)
                throw new NotFoundException('Invitation not found');
            const claimed = await tx.invitation.updateMany({
                where: { id: invitationId, status: 'PENDING' },
                data: { status: 'REVOKED' },
            });
            if (!claimed.count)
                throw new BadRequestException(
                    'Invitation is no longer pending',
                );
            const result = { ...invitation, status: 'REVOKED' as const };
            await this.notifyTransition(result, tx, actorId);
            return result;
        });
        return new InvitationEntity(updated);
    }

    async accept(token: string, userId: string) {
        const invitation = await this.prisma.invitation.findUnique({
            where: { token },
            select: { id: true },
        });
        if (!invitation) throw new NotFoundException('Invitation not found');
        return this.acceptById(invitation.id, userId);
    }

    async acceptById(id: string, userId: string) {
        const updated = await this.prisma.$transaction(async (tx) => {
            const invitation = await tx.invitation.findUnique({
                where: { id },
                include: invitationInclude,
            });
            if (!invitation || invitation.organization.deletedAt)
                throw new NotFoundException('Invitation not found');
            const user = await this.assertInvitee(invitation, userId, tx);
            if (invitation.status !== 'PENDING')
                throw new BadRequestException(
                    'Invitation is no longer pending',
                );
            if (invitation.role === 'OWNER')
                throw new BadRequestException(
                    'An invitation cannot assign OWNER',
                );
            if (invitation.expiresAt <= new Date()) {
                const claimed = await tx.invitation.updateMany({
                    where: {
                        id,
                        status: 'PENDING',
                        expiresAt: { lte: new Date() },
                    },
                    data: { status: 'EXPIRED' },
                });
                if (!claimed.count)
                    throw new ConflictException(
                        'Invitation was already processed',
                    );
                await this.notifyTransition(
                    { ...invitation, status: 'EXPIRED' },
                    tx,
                );
                return null;
            }
            const membership = await tx.membership.findUnique({
                where: {
                    userId_organizationId: {
                        userId,
                        organizationId: invitation.organizationId,
                    },
                },
            });
            if (membership)
                throw new ConflictException(
                    'You are already a member of this organization',
                );
            await this.quotaService.assertCanCreate(
                invitation.organizationId,
                'members',
            );
            const claimed = await tx.invitation.updateMany({
                where: { id, status: 'PENDING', expiresAt: { gt: new Date() } },
                data: { status: 'ACCEPTED', acceptedAt: new Date() },
            });
            if (!claimed.count)
                throw new ConflictException('Invitation was already processed');
            await tx.membership.create({
                data: {
                    userId,
                    organizationId: invitation.organizationId,
                    role: invitation.role,
                    invitedById: invitation.sentById,
                },
            });
            const result = await tx.invitation.findUniqueOrThrow({
                where: { id },
                include: invitationInclude,
            });
            await this.notifyTransition(result, tx, userId, userId);
            await this.notificationsService.enqueueEmail(
                EmailTemplate.WELCOME,
                {
                    to: user.email,
                    name: user.name,
                    orgName: invitation.organization.name,
                },
                `invitation-welcome:${id}`,
                tx,
                { userId, organizationId: invitation.organizationId },
            );
            return result;
        });
        if (!updated) throw new BadRequestException('Invitation has expired');
        return new InvitationEntity(updated);
    }

    async decline(token: string, userId: string) {
        const invitation = await this.prisma.invitation.findUnique({
            where: { token },
            select: { id: true },
        });
        if (!invitation) throw new NotFoundException('Invitation not found');
        return this.declineById(invitation.id, userId);
    }

    async declineById(id: string, userId: string) {
        const updated = await this.prisma.$transaction(async (tx) => {
            const invitation = await tx.invitation.findUnique({
                where: { id },
                include: invitationInclude,
            });
            if (!invitation || invitation.organization.deletedAt)
                throw new NotFoundException('Invitation not found');
            await this.assertInvitee(invitation, userId, tx);
            if (invitation.status !== 'PENDING')
                throw new BadRequestException(
                    'Invitation is no longer pending',
                );
            const status: InvitationStatus =
                invitation.expiresAt <= new Date() ? 'EXPIRED' : 'DECLINED';
            const claimed = await tx.invitation.updateMany({
                where: { id, status: 'PENDING' },
                data: { status },
            });
            if (!claimed.count)
                throw new ConflictException('Invitation was already processed');
            const result = { ...invitation, status };
            await this.notifyTransition(result, tx, userId);
            return result;
        });
        if (updated.status === 'EXPIRED')
            throw new BadRequestException('Invitation has expired');
        return new InvitationEntity(updated);
    }

    async expirePending(): Promise<number> {
        let count = 0;
        let cursor: string | undefined;
        const now = new Date();
        for (;;) {
            const invitations = await this.prisma.invitation.findMany({
                where: {
                    status: 'PENDING',
                    expiresAt: { lte: now },
                    ...(cursor ? { id: { gt: cursor } } : {}),
                },
                include: invitationInclude,
                take: 200,
                orderBy: { id: 'asc' },
            });
            for (const invitation of invitations) {
                count += await this.prisma.$transaction(async (tx) => {
                    const claimed = await tx.invitation.updateMany({
                        where: {
                            id: invitation.id,
                            status: 'PENDING',
                            expiresAt: { lte: now },
                        },
                        data: { status: 'EXPIRED' },
                    });
                    if (!claimed.count) return 0;
                    await this.notifyTransition(
                        { ...invitation, status: 'EXPIRED' },
                        tx,
                    );
                    return 1;
                });
            }
            if (invitations.length < 200) break;
            cursor = invitations[invitations.length - 1].id;
        }
        return count;
    }

    private async assertVerifiedUser(userId: string, db: NotificationDb) {
        const user = await db.user.findFirst({
            where: {
                id: userId,
                deletedAt: null,
                isActive: true,
                emailVerified: true,
            },
            select: { email: true, name: true },
        });
        if (!user)
            throw new ForbiddenException(
                'A verified email address is required',
            );
        return user;
    }

    private async assertInvitee(
        invitation: { email: string },
        userId: string,
        db: NotificationDb,
    ) {
        const user = await this.assertVerifiedUser(userId, db);
        if (
            user.email.trim().toLowerCase() !==
            invitation.email.trim().toLowerCase()
        ) {
            throw new ForbiddenException(
                'This invitation belongs to another email address',
            );
        }
        return user;
    }

    private async notifyTransition(
        invitation: Invitation,
        tx: NotificationDb,
        actorId?: string,
        joinedUserId?: string,
    ) {
        const status = invitation.status;
        const types = {
            ACCEPTED: 'INVITATION_ACCEPTED',
            DECLINED: 'INVITATION_DECLINED',
            REVOKED: 'INVITATION_REVOKED',
            EXPIRED: 'INVITATION_EXPIRED',
        } as const;
        if (status === InvitationStatus.PENDING) return;
        const meta = {
            organizationId: invitation.organizationId,
            invitationStatus: status,
            invitationExpiresAt: invitation.expiresAt.toISOString(),
            actionable: false,
        };
        await tx.notification.updateMany({
            where: { resourceType: 'Invitation', resourceId: invitation.id },
            data: { meta },
        });
        const user = await tx.user.findFirst({
            where: {
                email: { equals: invitation.email, mode: 'insensitive' },
                deletedAt: null,
                isActive: true,
                emailVerified: true,
            },
            select: { id: true },
        });
        const recipients =
            status === 'REVOKED'
                ? user
                    ? [user.id]
                    : []
                : [
                      invitation.sentById,
                      ...(status === 'ACCEPTED'
                          ? await this.notificationsService.organizationRecipients(
                                invitation.organizationId,
                                tx,
                                ADMIN_ROLES,
                            )
                          : []),
                  ];
        await this.notificationsService.publish(
            {
                eventKey: `invitation:${invitation.id}:${status}`,
                recipients: [
                    ...(joinedUserId
                        ? [
                              {
                                  userId: joinedUserId,
                                  type: 'MEMBER_JOINED' as const,
                                  title: `You joined ${invitation.organization.name}`,
                              },
                          ]
                        : []),
                    ...recipients,
                ],
                type: types[status],
                title: `Invitation to ${invitation.organization.name} ${status.toLowerCase()}`,
                body: `The invitation for ${invitation.email} is ${status.toLowerCase()}.`,
                resourceType: 'Invitation',
                resourceId: invitation.id,
                organizationId: invitation.organizationId,
                actorId,
                includeActor: !!joinedUserId,
                allowOutsideOrg: true,
                meta,
            },
            tx,
        );
    }
}
