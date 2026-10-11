import {
    Injectable,
    NotFoundException,
    ForbiddenException,
    BadRequestException,
    ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { UpdateMemberRoleDto } from './dto';
import { MembershipEntity } from './entities';
import { MembershipRole } from '../../generated/prisma/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { ADMIN_ROLES } from '../notifications/notification-event';

@Injectable()
export class MembershipsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly notificationsService: NotificationsService,
    ) {}

    async findAll(orgId: string) {
        const memberships = await this.prisma.membership.findMany({
            where: { organizationId: orgId },
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
            orderBy: { joinedAt: 'asc' },
        });

        return memberships.map((m) => new MembershipEntity(m));
    }

    async updateRole(
        orgId: string,
        targetUserId: string,
        actorUserId: string,
        dto: UpdateMemberRoleDto,
    ) {
        const membership = await this.findMembership(orgId, targetUserId);

        // Cannot change the owner's role via this endpoint
        if (membership.role === 'OWNER') {
            throw new ForbiddenException(
                'Cannot change owner role — use transfer ownership instead',
            );
        }

        // Cannot promote someone to OWNER via this endpoint
        if (dto.role === 'OWNER') {
            throw new BadRequestException(
                'Use the transfer ownership endpoint to assign OWNER role',
            );
        }

        // Cannot change your own role
        if (targetUserId === actorUserId) {
            throw new BadRequestException('Cannot change your own role');
        }

        if (membership.role === dto.role)
            return new MembershipEntity(membership);
        const updated = await this.prisma.$transaction(async (tx) => {
            const claimed = await tx.membership.updateMany({
                where: { id: membership.id, role: membership.role },
                data: { role: dto.role },
            });
            const updated = await tx.membership.findUniqueOrThrow({
                where: { id: membership.id },
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
            if (!claimed.count) {
                if (updated.role === dto.role) return updated;
                throw new ConflictException(
                    'Member role changed; reload and retry',
                );
            }
            await this.notificationsService.publish(
                {
                    eventKey: `membership-role:${updated.id}:${updated.updatedAt.toISOString()}`,
                    type: 'MEMBER_ROLE_CHANGED',
                    title: 'Organization role changed',
                    body: `${updated.user.name}'s role changed from ${membership.role} to ${dto.role}.`,
                    resourceType: 'Organization',
                    resourceId: orgId,
                    organizationId: orgId,
                    actorId: actorUserId,
                    recipients: [
                        { userId: targetUserId, email: true },
                        ...(membership.role === 'ADMIN' || dto.role === 'ADMIN'
                            ? await this.notificationsService.organizationRecipients(
                                  orgId,
                                  tx,
                                  ADMIN_ROLES,
                              )
                            : []),
                    ],
                    meta: { oldRole: membership.role, newRole: dto.role },
                },
                tx,
            );
            return updated;
        });

        return new MembershipEntity(updated);
    }

    async removeMember(
        orgId: string,
        targetUserId: string,
        actorUserId: string,
    ) {
        const membership = await this.findMembership(orgId, targetUserId);

        // Cannot remove the owner
        if (membership.role === 'OWNER') {
            throw new ForbiddenException(
                'Cannot remove the organization owner',
            );
        }

        // Cannot remove yourself via this endpoint
        if (targetUserId === actorUserId) {
            throw new BadRequestException(
                'Use the leave endpoint to remove yourself',
            );
        }

        await this.prisma.$transaction(async (tx) => {
            await tx.membership.delete({ where: { id: membership.id } });
            await this.notificationsService.publish(
                {
                    eventKey: `member-removed:${membership.id}`,
                    type: 'MEMBER_REMOVED',
                    title: 'You were removed from an organization',
                    resourceType: 'Organization',
                    resourceId: orgId,
                    organizationId: orgId,
                    actorId: actorUserId,
                    allowOutsideOrg: true,
                    recipients: [{ userId: targetUserId, email: true }],
                },
                tx,
            );
            await this.notificationsService.publish(
                {
                    eventKey: `member-removed-admin:${membership.id}`,
                    type: 'MEMBER_REMOVED',
                    title: 'A member was removed from the organization',
                    resourceType: 'Organization',
                    resourceId: orgId,
                    organizationId: orgId,
                    actorId: actorUserId,
                    recipients:
                        await this.notificationsService.organizationRecipients(
                            orgId,
                            tx,
                            ADMIN_ROLES,
                        ),
                    meta: { memberId: targetUserId },
                },
                tx,
            );
        });
    }

    async leaveOrganization(orgId: string, userId: string) {
        const membership = await this.findMembership(orgId, userId);

        // Owner cannot leave — must transfer first
        if (membership.role === 'OWNER') {
            throw new ForbiddenException(
                'Owner cannot leave — transfer ownership first',
            );
        }

        await this.prisma.$transaction(async (tx) => {
            await tx.membership.delete({ where: { id: membership.id } });
            await this.notificationsService.publish(
                {
                    eventKey: `member-left:${membership.id}`,
                    type: 'MEMBER_LEFT',
                    title: 'A member left the organization',
                    resourceType: 'Organization',
                    resourceId: orgId,
                    organizationId: orgId,
                    actorId: userId,
                    recipients:
                        await this.notificationsService.organizationRecipients(
                            orgId,
                            tx,
                            ADMIN_ROLES,
                        ),
                    meta: { memberId: userId },
                },
                tx,
            );
        });
    }

    async getMembershipRole(
        orgId: string,
        userId: string,
    ): Promise<MembershipRole | null> {
        const membership = await this.prisma.membership.findUnique({
            where: {
                userId_organizationId: {
                    userId,
                    organizationId: orgId,
                },
            },
        });
        return (membership?.role as MembershipRole) ?? null;
    }

    private async findMembership(orgId: string, userId: string) {
        const membership = await this.prisma.membership.findUnique({
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
                    userId,
                    organizationId: orgId,
                },
            },
        });

        if (!membership) {
            throw new NotFoundException('Membership not found');
        }

        return membership;
    }
}
