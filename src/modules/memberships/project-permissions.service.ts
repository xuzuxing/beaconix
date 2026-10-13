import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { ProjectAccessService } from '../../common/authorization/project-access.service';
import { projectCapabilities } from '../../common/authorization/project-policy';
import {
    lockIdentities,
    lockMemberships,
    lockOrganization,
    lockProjects,
    retryAccessTransaction,
    type AccessDb,
} from '../../common/authorization/access-locks';
import {
    assertGrantProjects,
    validateProjectGrants,
} from '../../common/authorization/project-grants';
import type { ReplaceProjectPermissionsDto } from './dto/project-permissions.dto';
import type { OrganizationAccess } from '../../common/authorization/access.types';

@Injectable()
export class ProjectPermissionsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ProjectAccessService,
    ) {}

    async organizationPermissions(orgId: string, actorId: string) {
        const access = await this.access.organization(
            { type: 'USER', userId: actorId },
            orgId,
        );
        return this.organizationProjection(access);
    }

    async findMemberPermissions(
        orgId: string,
        userId: string,
        actorId: string,
    ) {
        const access = await this.access.organization(
            { type: 'USER', userId: actorId },
            orgId,
        );
        if (actorId !== userId && !access.canManageOrganization) {
            throw new ForbiddenException(
                'Only administrators can view another member permissions',
            );
        }
        return this.memberProjection(orgId, userId, this.prisma);
    }

    async replace(
        orgId: string,
        userId: string,
        actorId: string,
        dto: ReplaceProjectPermissionsDto,
    ) {
        if (
            !dto.expectedMembershipId ||
            !Number.isInteger(dto.expectedVersion) ||
            dto.expectedVersion < 0
        )
            throw new BadRequestException(
                'Membership ID and nonnegative version are required',
            );
        return retryAccessTransaction(() =>
            this.prisma.$transaction(async (tx) => {
                await lockIdentities(tx, [
                    { type: 'USER', userId: actorId },
                    { type: 'USER', userId },
                ]);
                await lockOrganization(tx, orgId);
                const participants = await tx.membership.findMany({
                    where: {
                        organizationId: orgId,
                        userId: { in: [actorId, userId] },
                    },
                    select: { id: true, userId: true },
                });
                await lockMemberships(
                    tx,
                    participants.map((member) => ({
                        id: member.id,
                        update: member.userId === userId,
                    })),
                );
                const actor = await this.access.organization(
                    { type: 'USER', userId: actorId },
                    orgId,
                    tx,
                );
                if (!actor.canManageOrganization)
                    throw new ForbiddenException(
                        'Organization administration required',
                    );
                const target = await tx.membership.findUnique({
                    where: {
                        userId_organizationId: {
                            userId,
                            organizationId: orgId,
                        },
                    },
                });
                if (!target)
                    throw new NotFoundException('Membership not found');
                if (
                    target.id !== dto.expectedMembershipId ||
                    target.projectPermissionsVersion !== dto.expectedVersion
                ) {
                    throw new ConflictException(
                        'Membership or permissions changed; reload and retry',
                    );
                }
                if (target.role === 'OWNER' || target.role === 'ADMIN') {
                    throw new BadRequestException(
                        'Organization administrators inherit all projects',
                    );
                }
                const grants = validateProjectGrants(target.role, dto.projects);
                await lockProjects(
                    tx,
                    grants.map((grant) => grant.projectId),
                );
                await assertGrantProjects(tx, orgId, grants);
                const beforeGrants = await tx.projectMembership.findMany({
                    where: { membershipId: target.id, organizationId: orgId },
                    select: { projectId: true, role: true },
                    orderBy: { projectId: 'asc' },
                });
                const before = {
                    targetUserId: userId,
                    membershipId: target.id,
                    projectPermissionsVersion: target.projectPermissionsVersion,
                    projects: beforeGrants,
                };
                await tx.projectMembership.deleteMany({
                    where: { membershipId: target.id, organizationId: orgId },
                });
                if (grants.length) {
                    await tx.projectMembership.createMany({
                        data: grants.map((grant) => ({
                            ...grant,
                            membershipId: target.id,
                            organizationId: orgId,
                            grantedById: actorId,
                        })),
                    });
                }
                await tx.membership.update({
                    where: { id: target.id },
                    data: { projectPermissionsVersion: { increment: 1 } },
                });
                const after = await this.memberProjection(orgId, userId, tx);
                await tx.auditLog.create({
                    data: {
                        actorId,
                        organizationId: orgId,
                        action: 'UPDATE',
                        entity: 'ProjectPermissions',
                        entityId: target.id,
                        before,
                        after,
                    },
                });
                return after;
            }),
        );
    }

    async projectPermissions(projectId: string, actorId: string) {
        const access = await this.access.project(
            { type: 'USER', userId: actorId },
            projectId,
        );
        return {
            ...this.organizationProjection(access),
            projectId,
            assignedRole: access.assignedRole,
            effectiveRole: access.effectiveRole,
            capabilities: projectCapabilities(access),
        };
    }

    async projectMembers(projectId: string, actorId: string) {
        const access = await this.access.project(
            { type: 'USER', userId: actorId },
            projectId,
        );
        const members = await this.prisma.membership.findMany({
            where: {
                organizationId: access.organizationId,
                user: { isActive: true, deletedAt: null },
                OR: [
                    { role: { in: ['OWNER', 'ADMIN'] } },
                    {
                        projectMemberships: {
                            some: {
                                projectId,
                                organizationId: access.organizationId,
                            },
                        },
                    },
                ],
            },
            select: {
                role: true,
                user: { select: { id: true, name: true, avatarUrl: true } },
                projectMemberships: {
                    where: { projectId, organizationId: access.organizationId },
                    select: { role: true },
                },
            },
            orderBy: { joinedAt: 'asc' },
        });
        return members.map((member) => ({
            ...member.user,
            effectiveRole:
                member.role === 'OWNER' || member.role === 'ADMIN'
                    ? 'ADMIN'
                    : member.role === 'VIEWER'
                      ? 'VIEWER'
                      : member.projectMemberships[0].role,
        }));
    }

    async probeOptions(projectId: string, actorId: string) {
        const access = await this.access.project(
            { type: 'USER', userId: actorId },
            projectId,
        );
        return this.prisma.probe.findMany({
            where: {
                organizationId: access.organizationId,
                scope: 'TENANT',
                enabled: true,
            },
            select: { id: true, name: true, status: true },
            orderBy: { name: 'asc' },
        });
    }

    async notificationChannelOptions(projectId: string, actorId: string) {
        const access = await this.access.project(
            { type: 'USER', userId: actorId },
            projectId,
        );
        return this.prisma.notificationChannel.findMany({
            where: { organizationId: access.organizationId, enabled: true },
            select: { id: true, name: true, type: true },
            orderBy: { name: 'asc' },
        });
    }

    private organizationProjection(access: OrganizationAccess) {
        return {
            organizationId: access.organizationId,
            organizationRole: access.organizationRole,
            membershipId: access.membershipId,
            projectPermissionsVersion: access.projectPermissionsVersion,
            accessMode: access.accessMode,
            capabilities: {
                manageOrganization: access.canManageOrganization,
                manageProjectPermissions: access.canManageOrganization,
                inviteMembers: access.canManageOrganization,
                grantOrganizationAdmin: access.canGrantOrganizationAdmin,
            },
        };
    }

    private async memberProjection(
        orgId: string,
        userId: string,
        db: AccessDb,
    ) {
        const membership = await db.membership.findUnique({
            where: { userId_organizationId: { userId, organizationId: orgId } },
            include: {
                projectMemberships: {
                    where: {
                        organizationId: orgId,
                        project: { deletedAt: null },
                    },
                    select: {
                        projectId: true,
                        role: true,
                        project: { select: { name: true } },
                    },
                    orderBy: { projectId: 'asc' },
                },
            },
        });
        if (!membership) throw new NotFoundException('Membership not found');
        const all = membership.role === 'OWNER' || membership.role === 'ADMIN';
        return {
            userId,
            organizationId: orgId,
            membershipId: membership.id,
            projectPermissionsVersion: membership.projectPermissionsVersion,
            organizationRole: membership.role,
            accessMode: all ? 'ALL_PROJECTS' : 'SELECTED_PROJECTS',
            projects: membership.projectMemberships.map((grant) => ({
                projectId: grant.projectId,
                projectName: grant.project.name,
                assignedRole: grant.role,
                effectiveRole: all
                    ? 'ADMIN'
                    : membership.role === 'VIEWER'
                      ? 'VIEWER'
                      : grant.role,
            })),
        };
    }
}
