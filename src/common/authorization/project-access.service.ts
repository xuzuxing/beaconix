import {
    ForbiddenException,
    Injectable,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import {
    lockIdentities,
    lockOrganization,
    lockMemberships,
    lockProjects,
    retryAccessTransaction,
    type AccessDb,
    type ProjectLockMode,
} from './access-locks';
import {
    isSystemPrincipal,
    type AccessPrincipal,
    type OrganizationAccess,
    type ProjectAccess,
} from './access.types';
import { allowsProjectAction, type ProjectAction } from './project-policy';

@Injectable()
export class ProjectAccessService {
    constructor(private readonly prisma: PrismaService) {}

    async withOrganization<T>(
        principal: AccessPrincipal,
        organizationId: string,
        work: (tx: AccessDb, access: OrganizationAccess) => Promise<T>,
    ): Promise<T> {
        return retryAccessTransaction(() =>
            this.prisma.$transaction(async (tx) => {
                await lockIdentities(tx, [principal]);
                await lockOrganization(tx, organizationId);
                if (principal.type === 'USER') {
                    const memberships = await tx.membership.findMany({
                        where: { userId: principal.userId, organizationId },
                        select: { id: true },
                    });
                    await lockMemberships(tx, memberships);
                }
                const access = await this.organization(
                    principal,
                    organizationId,
                    tx,
                );
                if (!access.canManageOrganization)
                    throw new ForbiddenException(
                        'Organization administrator required',
                    );
                return work(tx, access);
            }),
        );
    }

    async withProjectWrite<T>(
        principal: AccessPrincipal,
        organizationId: string,
        projectId: string,
        action: ProjectAction,
        work: (tx: AccessDb, access: ProjectAccess) => Promise<T>,
        projectLock: ProjectLockMode = 'SHARE',
        participantIds: string[] = [],
    ): Promise<T> {
        const principals: AccessPrincipal[] = [
            principal,
            ...participantIds.map((userId) => ({
                type: 'USER' as const,
                userId,
            })),
        ];
        return retryAccessTransaction(() =>
            this.prisma.$transaction(async (tx) => {
                await lockIdentities(tx, principals);
                await lockOrganization(tx, organizationId);
                const userIds = [
                    ...new Set(
                        principals.flatMap((identity) =>
                            identity.type === 'USER' ? [identity.userId] : [],
                        ),
                    ),
                ];
                const memberships = userIds.length
                    ? await tx.membership.findMany({
                          where: { organizationId, userId: { in: userIds } },
                          select: { id: true },
                      })
                    : [];
                await lockMemberships(tx, memberships);
                await lockProjects(tx, [projectId], projectLock);
                const access = await this.project(
                    principal,
                    projectId,
                    action,
                    organizationId,
                    tx,
                );
                return work(tx, access);
            }),
        );
    }

    async withProject<T>(
        principal: AccessPrincipal,
        projectId: string,
        action: ProjectAction,
        work: (tx: AccessDb, access: ProjectAccess) => Promise<T>,
        projectLock: ProjectLockMode = 'SHARE',
        participantIds: string[] = [],
    ): Promise<T> {
        const project = await this.prisma.project.findFirst({
            where: { id: projectId, deletedAt: null },
            select: { organizationId: true },
        });
        if (!project) throw new NotFoundException('Project not found');
        return this.withProjectWrite(
            principal,
            project.organizationId,
            projectId,
            action,
            work,
            projectLock,
            participantIds,
        );
    }

    projectMemberFilter(
        organizationId: string,
        projectId: string,
        writable = false,
    ): Prisma.MembershipWhereInput {
        return {
            organizationId,
            user: { isActive: true, deletedAt: null },
            organization: { deletedAt: null },
            OR: [
                { role: { in: ['OWNER', 'ADMIN'] } },
                {
                    role: { in: writable ? ['MEMBER'] : ['MEMBER', 'VIEWER'] },
                    projectMemberships: {
                        some: {
                            organizationId,
                            projectId,
                            ...(writable
                                ? { role: { in: ['MEMBER', 'ADMIN'] } }
                                : {}),
                            project: { deletedAt: null },
                        },
                    },
                },
            ],
        };
    }

    async task(
        principal: AccessPrincipal,
        taskId: string,
        action: ProjectAction = 'project.read',
        db: AccessDb = this.prisma,
    ) {
        const task = await db.task.findFirst({
            where: { id: taskId, deletedAt: null },
        });
        if (!task) throw new NotFoundException('Task not found');
        const access = await this.project(
            principal,
            task.projectId,
            action,
            task.organizationId,
            db,
        );
        return { task, access };
    }

    async withTask<T>(
        principal: AccessPrincipal,
        taskId: string,
        action: ProjectAction,
        work: (
            tx: AccessDb,
            access: ProjectAccess,
            task: Prisma.TaskGetPayload<object>,
        ) => Promise<T>,
    ): Promise<T> {
        const { task } = await this.task(principal, taskId, action);
        return this.withProjectWrite(
            principal,
            task.organizationId,
            task.projectId,
            action,
            async (tx, access) => {
                await tx.$queryRaw`
                    SELECT "id" FROM "tasks" WHERE "id" = ${taskId} FOR UPDATE
                `;
                const current = await tx.task.findFirst({
                    where: {
                        id: taskId,
                        projectId: access.projectId,
                        organizationId: access.organizationId,
                        deletedAt: null,
                    },
                });
                if (!current) throw new NotFoundException('Task not found');
                return work(tx, access, current);
            },
        );
    }

    async organization(
        principal: AccessPrincipal,
        organizationId: string,
        db: AccessDb = this.prisma,
    ): Promise<OrganizationAccess> {
        let globalRole: OrganizationAccess['globalRole'] = null;
        let platformAuthorityVersion: number | null = null;
        if (!principal)
            throw new UnauthorizedException('Authentication required');
        if (principal.type === 'USER') {
            const user = await db.user.findFirst({
                where: {
                    id: principal.userId,
                    isActive: true,
                    deletedAt: null,
                },
                select: { globalRole: true, platformAuthorityVersion: true },
            });
            if (!user)
                throw new UnauthorizedException('User is no longer active');
            globalRole = user.globalRole;
            platformAuthorityVersion = user.platformAuthorityVersion;
            if (principal.patId) {
                const token = await db.personalAccessToken.findFirst({
                    where: {
                        id: principal.patId,
                        userId: principal.userId,
                        revokedAt: null,
                        OR: [
                            { expiresAt: null },
                            { expiresAt: { gt: new Date() } },
                        ],
                    },
                    select: { id: true },
                });
                if (!token)
                    throw new UnauthorizedException(
                        'Invalid personal access token',
                    );
            }
        } else if (principal.type === 'API_KEY') {
            const key = await db.apiKey.findFirst({
                where: {
                    id: principal.keyId,
                    organizationId,
                    revokedAt: null,
                    OR: [
                        { expiresAt: null },
                        { expiresAt: { gt: new Date() } },
                    ],
                },
                select: { id: true },
            });
            if (!key || principal.organizationId !== organizationId) {
                throw new UnauthorizedException('Invalid organization API key');
            }
        } else if (!isSystemPrincipal(principal)) {
            throw new UnauthorizedException('Invalid access principal');
        }
        const organization = await db.organization.findFirst({
            where: { id: organizationId, deletedAt: null },
            select: { id: true },
        });
        if (!organization)
            throw new NotFoundException('Organization not found');

        const membership =
            principal.type === 'USER'
                ? await db.membership.findUnique({
                      where: {
                          userId_organizationId: {
                              userId: principal.userId,
                              organizationId,
                          },
                      },
                  })
                : null;
        const platform = globalRole === 'SUPER_ADMIN';
        const internal = isSystemPrincipal(principal);
        if (principal.type === 'USER' && !platform && !membership) {
            throw new NotFoundException('Organization not found');
        }
        const administrator =
            membership?.role === 'OWNER' || membership?.role === 'ADMIN';
        return {
            principal,
            organizationId,
            globalRole,
            organizationRole: membership?.role ?? null,
            membershipId: membership?.id ?? null,
            projectPermissionsVersion:
                membership?.projectPermissionsVersion ?? null,
            platformAuthorityVersion,
            accessMode:
                platform ||
                internal ||
                principal.type === 'API_KEY' ||
                administrator
                    ? 'ALL_PROJECTS'
                    : 'SELECTED_PROJECTS',
            // Machine scopes authorize monitoring only, never human team administration.
            canManageOrganization: platform || internal || administrator,
            canGrantOrganizationAdmin:
                platform || internal || membership?.role === 'OWNER',
        };
    }

    async project(
        principal: AccessPrincipal,
        projectId: string,
        action: ProjectAction = 'project.read',
        expectedOrganizationId?: string,
        db: AccessDb = this.prisma,
    ): Promise<ProjectAccess> {
        const project = await db.project.findFirst({
            where: {
                id: projectId,
                ...(expectedOrganizationId
                    ? { organizationId: expectedOrganizationId }
                    : {}),
                ...(action === 'project.restore' ? {} : { deletedAt: null }),
                organization: { deletedAt: null },
            },
            select: { id: true, organizationId: true, status: true },
        });
        if (!project) throw new NotFoundException('Project not found');
        const organization = await this.organization(
            principal,
            project.organizationId,
            db,
        );
        const grant = organization.membershipId
            ? await db.projectMembership.findUnique({
                  where: {
                      membershipId_projectId: {
                          membershipId: organization.membershipId,
                          projectId,
                      },
                  },
              })
            : null;
        if (
            organization.accessMode === 'SELECTED_PROJECTS' &&
            (!grant || grant.organizationId !== project.organizationId)
        ) {
            throw new NotFoundException('Project not found');
        }
        const access: ProjectAccess = {
            ...organization,
            projectId,
            projectStatus: project.status,
            assignedRole: grant?.role ?? null,
            effectiveRole:
                organization.accessMode === 'ALL_PROJECTS'
                    ? 'ADMIN'
                    : organization.organizationRole === 'VIEWER'
                      ? 'VIEWER'
                      : grant!.role,
        };
        if (!allowsProjectAction(access, action)) {
            throw new ForbiddenException('Insufficient project permission');
        }
        await this.assertCredentialScope(principal, action, db);
        return access;
    }

    async projectFilter(
        principal: AccessPrincipal,
        organizationId: string,
        db: AccessDb = this.prisma,
        scopeAction: ProjectAction = 'monitor.read',
    ): Promise<Prisma.ProjectWhereInput> {
        const access = await this.organization(principal, organizationId, db);
        if (
            principal.type === 'API_KEY' ||
            (principal.type === 'USER' && principal.patId)
        ) {
            await this.assertCredentialScope(principal, scopeAction, db);
        }
        return {
            organizationId,
            deletedAt: null,
            organization: { deletedAt: null },
            ...(access.accessMode === 'SELECTED_PROJECTS'
                ? {
                      memberships: {
                          some: {
                              membershipId: access.membershipId!,
                              organizationId,
                          },
                      },
                  }
                : {}),
        };
    }

    private async assertCredentialScope(
        principal: AccessPrincipal,
        action: ProjectAction,
        db: AccessDb,
    ) {
        if (
            principal.type !== 'API_KEY' &&
            !(principal.type === 'USER' && principal.patId)
        )
            return;
        const scope = {
            'project.read': 'monitors:read',
            'monitor.read': 'monitors:read',
            'monitoring.read': 'monitoring:read',
            'monitor.check': 'monitors:write',
            'monitor.manage': 'monitors:write',
            'monitor.restore': 'monitors:write',
            'monitor.test-alert': 'monitors:write',
            'rule.manage': 'monitors:write',
            'alert.retry': 'monitors:write',
        }[action] as string | undefined;
        const credential =
            principal.type === 'API_KEY'
                ? await db.apiKey.findUnique({
                      where: { id: principal.keyId },
                      select: { scopes: true },
                  })
                : await db.personalAccessToken.findUnique({
                      where: { id: principal.patId },
                      select: { scopes: true },
                  });
        if (!scope || !credential?.scopes.includes(scope)) {
            throw new ForbiddenException('Insufficient credential scope');
        }
    }
}
