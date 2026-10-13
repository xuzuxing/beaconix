import {
    Injectable,
    NotFoundException,
    BadRequestException,
    ConflictException,
    ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { toIsoString } from '../../common/utils/date.util';
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
import { ProjectAccessService } from '../../common/authorization/project-access.service';
import {
    lockIdentities,
    lockMemberships,
    lockOrganization,
    lockProjects,
    lockOrganizationMembers,
    type AccessDb,
} from '../../common/authorization/access-locks';
import {
    assertGrantProjects,
    validateProjectGrants,
} from '../../common/authorization/project-grants';

const invitationInclude = {
    organization: {
        select: { id: true, name: true, slug: true, deletedAt: true },
    },
    sentBy: { select: { id: true, name: true, email: true } },
    projectGrants: {
        include: { project: { select: { name: true } } },
        orderBy: { projectId: 'asc' },
    },
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
        private readonly access: ProjectAccessService,
    ) {}

    async send(orgId: string, senderId: string, dto: CreateInvitationDto) {
        if (dto.role === 'OWNER')
            throw new BadRequestException('An invitation cannot assign OWNER');
        const role = dto.role ?? 'MEMBER';
        const grants = validateProjectGrants(role, dto.projects, true);
        const email = dto.email.trim().toLowerCase();
        try {
            const invitation = await this.prisma.$transaction(async (tx) => {
                await lockIdentities(tx, [{ type: 'USER', userId: senderId }]);
                await lockOrganization(tx, orgId, 'UPDATE');
                const senderMembership = await tx.membership.findUnique({
                    where: {
                        userId_organizationId: {
                            userId: senderId,
                            organizationId: orgId,
                        },
                    },
                });
                await lockMemberships(
                    tx,
                    senderMembership ? [{ id: senderMembership.id }] : [],
                );
                const sender = await this.access.organization(
                    { type: 'USER', userId: senderId },
                    orgId,
                    tx,
                );
                if (
                    !sender.canManageOrganization ||
                    (role === 'ADMIN' && !sender.canGrantOrganizationAdmin)
                ) {
                    throw new ForbiddenException(
                        'Insufficient invitation authority',
                    );
                }
                await lockProjects(
                    tx,
                    grants.map((grant) => grant.projectId),
                );
                await assertGrantProjects(tx, orgId, grants);
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
                        role,
                        sentById: senderId,
                        issuerType:
                            sender.globalRole === 'SUPER_ADMIN'
                                ? 'PLATFORM'
                                : 'ORGANIZATION',
                        issuerMembershipId:
                            sender.globalRole === 'SUPER_ADMIN'
                                ? null
                                : sender.membershipId,
                        issuerAuthorityVersion:
                            sender.globalRole === 'SUPER_ADMIN'
                                ? sender.platformAuthorityVersion
                                : null,
                        projectGrants: {
                            create: grants.map((grant) => ({
                                ...grant,
                                organizationId: orgId,
                            })),
                        },
                        expiresAt: new Date(Date.now() + 7 * 86400_000),
                    },
                    include: invitationInclude,
                });
                await tx.auditLog.create({
                    data: {
                        actorId: senderId,
                        organizationId: orgId,
                        action: 'INVITE',
                        entity: 'Invitation',
                        entityId: created.id,
                        after: {
                            role,
                            email,
                            projects: grants.map((grant) => ({
                                projectId: grant.projectId,
                                role: grant.role,
                            })),
                        },
                    },
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
                                invitationExpiresAt: toIsoString(
                                    created.expiresAt,
                                ),
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
                    {
                        accessScope: 'INVITATION',
                        invitationId: created.id,
                        organizationId: orgId,
                        email,
                    },
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
            select: {
                status: true,
                expiresAt: true,
                organization: { select: { name: true, deletedAt: true } },
            },
        });
        if (!invitation || invitation.organization.deletedAt)
            throw new NotFoundException('Invitation not found');
        return {
            organizationName: invitation.organization.name,
            status:
                invitation.status === 'PENDING' &&
                invitation.expiresAt <= new Date()
                    ? 'EXPIRED'
                    : invitation.status,
            requiresLogin: true,
        };
    }

    async revoke(orgId: string, invitationId: string, actorId: string) {
        const updated = await this.prisma.$transaction(async (tx) => {
            await lockOrganizationMembers(tx, orgId, [actorId]);
            const actor = await this.access.organization(
                { type: 'USER', userId: actorId },
                orgId,
                tx,
            );
            if (!actor.canManageOrganization)
                throw new ForbiddenException(
                    'Organization administration required',
                );
            await tx.$queryRaw`SELECT "id" FROM "invitations" WHERE "id" = ${invitationId} AND "organizationId" = ${orgId} FOR UPDATE`;
            const invitation = await tx.invitation.findFirst({
                where: { id: invitationId, organizationId: orgId },
                include: invitationInclude,
            });
            if (!invitation)
                throw new NotFoundException('Invitation not found');
            if (
                invitation.role === 'ADMIN' &&
                !actor.canGrantOrganizationAdmin
            ) {
                throw new ForbiddenException(
                    'Owner authority required for administrator invitations',
                );
            }
            const claimed = await tx.invitation.updateMany({
                where: { id: invitationId, status: 'PENDING' },
                data: { status: 'REVOKED' },
            });
            if (!claimed.count)
                throw new BadRequestException(
                    'Invitation is no longer pending',
                );
            const result = { ...invitation, status: 'REVOKED' as const };
            await tx.auditLog.create({
                data: {
                    actorId,
                    organizationId: orgId,
                    action: 'DELETE',
                    entity: 'Invitation',
                    entityId: invitationId,
                    before: { status: invitation.status },
                    after: { status: result.status },
                },
            });
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
        const locator = await this.prisma.invitation.findUnique({
            where: { id },
            include: invitationInclude,
        });
        if (!locator) throw new NotFoundException('Invitation not found');
        const updated = await this.prisma.$transaction(async (tx) => {
            await lockIdentities(tx, [
                { type: 'USER', userId },
                { type: 'USER', userId: locator.sentById },
            ]);
            await lockOrganization(tx, locator.organizationId, 'UPDATE');
            const participants = await tx.membership.findMany({
                where: {
                    organizationId: locator.organizationId,
                    userId: { in: [userId, locator.sentById] },
                },
                select: { id: true },
            });
            await lockMemberships(tx, participants);
            await lockProjects(
                tx,
                locator.projectGrants.map((grant) => grant.projectId),
            );
            await tx.$queryRaw`SELECT "id" FROM "invitations" WHERE "id" = ${id} FOR UPDATE`;
            const invitation = await tx.invitation.findUnique({
                where: { id },
                include: invitationInclude,
            });
            if (!invitation || invitation.organization.deletedAt)
                throw new NotFoundException('Invitation not found');
            if (
                invitation.organizationId !== locator.organizationId ||
                invitation.sentById !== locator.sentById ||
                JSON.stringify(invitation.projectGrants) !==
                    JSON.stringify(locator.projectGrants)
            )
                throw new ConflictException(
                    'Invitation changed; reload and retry',
                );
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
            await this.assertIssuer(invitation, tx);
            let grants;
            try {
                grants = validateProjectGrants(
                    invitation.role,
                    invitation.role === 'ADMIN'
                        ? undefined
                        : invitation.projectGrants,
                    true,
                );
            } catch {
                throw new ConflictException(
                    'Invitation grants are no longer valid',
                );
            }
            if (
                invitation.role === 'ADMIN' &&
                invitation.projectGrants.length
            ) {
                throw new ConflictException(
                    'Administrator invitation cannot contain project grants',
                );
            }
            await assertGrantProjects(
                tx,
                invitation.organizationId,
                grants,
                true,
            );
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
            await this.quotaService.assertCanAddMember(
                invitation.organizationId,
                tx,
            );
            const claimed = await tx.invitation.updateMany({
                where: { id, status: 'PENDING', expiresAt: { gt: new Date() } },
                data: { status: 'ACCEPTED', acceptedAt: new Date() },
            });
            if (!claimed.count)
                throw new ConflictException('Invitation was already processed');
            const joined = await tx.membership.create({
                data: {
                    userId,
                    organizationId: invitation.organizationId,
                    role: invitation.role,
                    invitedById: invitation.sentById,
                },
            });
            if (grants.length) {
                await tx.projectMembership.createMany({
                    data: grants.map((grant) => ({
                        projectId: grant.projectId,
                        role: grant.role,
                        organizationId: invitation.organizationId,
                        membershipId: joined.id,
                        grantedById: invitation.sentById,
                    })),
                });
            }
            await tx.auditLog.create({
                data: {
                    actorId: userId,
                    organizationId: invitation.organizationId,
                    action: 'JOIN',
                    entity: 'Membership',
                    entityId: joined.id,
                    after: {
                        invitationId: id,
                        membershipId: joined.id,
                        userId,
                        role: invitation.role,
                        projects: grants.map((grant) => ({
                            projectId: grant.projectId,
                            role: grant.role,
                        })),
                    },
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
                {
                    accessScope: 'ORGANIZATION',
                    userId,
                    organizationId: invitation.organizationId,
                },
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
        const locator = await this.prisma.invitation.findUnique({
            where: { id },
            select: { organizationId: true },
        });
        if (!locator) throw new NotFoundException('Invitation not found');
        const updated = await this.prisma.$transaction(async (tx) => {
            await lockIdentities(tx, [{ type: 'USER', userId }]);
            await lockOrganization(tx, locator.organizationId);
            await tx.$queryRaw`SELECT "id" FROM "invitations" WHERE "id" = ${id} FOR UPDATE`;
            const invitation = await tx.invitation.findUnique({
                where: { id },
                include: invitationInclude,
            });
            if (!invitation || invitation.organization.deletedAt)
                throw new NotFoundException('Invitation not found');
            if (invitation.organizationId !== locator.organizationId) {
                throw new ConflictException(
                    'Invitation changed; reload and retry',
                );
            }
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
                    await lockOrganization(tx, invitation.organizationId);
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

    private async assertIssuer(invitation: Invitation, tx: AccessDb) {
        const issuer = await tx.user.findFirst({
            where: { id: invitation.sentById, isActive: true, deletedAt: null },
            select: { globalRole: true, platformAuthorityVersion: true },
        });
        if (!issuer)
            throw new ConflictException(
                'Invitation issuer is no longer active',
            );
        if (invitation.issuerType === 'PLATFORM') {
            if (
                invitation.issuerMembershipId !== null ||
                invitation.issuerAuthorityVersion === null ||
                issuer.globalRole !== 'SUPER_ADMIN' ||
                invitation.issuerAuthorityVersion !==
                    issuer.platformAuthorityVersion
            )
                throw new ConflictException(
                    'Platform invitation authority changed',
                );
            return;
        }
        if (
            invitation.issuerType !== 'ORGANIZATION' ||
            !invitation.issuerMembershipId ||
            invitation.issuerAuthorityVersion !== null
        ) {
            throw new ConflictException(
                'Legacy invitation must be revoked and reissued',
            );
        }
        const membership = await tx.membership.findFirst({
            where: {
                id: invitation.issuerMembershipId,
                userId: invitation.sentById,
                organizationId: invitation.organizationId,
            },
            select: { role: true },
        });
        if (
            !membership ||
            !['OWNER', 'ADMIN'].includes(membership.role) ||
            (invitation.role === 'ADMIN' && membership.role !== 'OWNER')
        )
            throw new ConflictException(
                'Organization invitation authority changed',
            );
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
            invitationExpiresAt: toIsoString(invitation.expiresAt),
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
