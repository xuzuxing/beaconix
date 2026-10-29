import { Injectable } from '@nestjs/common';
import { capacityStateKey } from '../../shared/subscription/monitor-capacity.util';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/database/prisma.service';
import { ProjectAccessService } from '../../common/authorization/project-access.service';
import type {
    NotificationAudience,
    NotificationDb,
} from './notification-event';
import { ADMIN_NOTIFICATION_TYPES, ADMIN_ROLES } from './notification-event';
import {
    lockIdentities,
    lockOrganization,
    lockMemberships,
    lockProjects,
    retryAccessTransaction,
} from '../../common/authorization/access-locks';

@Injectable()
export class NotificationAccessService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ProjectAccessService,
    ) {}

    async withWrite<T>(
        userId: string,
        work: (
            tx: NotificationDb,
            where: Prisma.NotificationWhereInput,
        ) => Promise<T>,
    ): Promise<T> {
        return retryAccessTransaction(() =>
            this.prisma.$transaction(async (tx) => {
                await lockIdentities(tx, [{ type: 'USER', userId }]);
                const user = await tx.user.findFirst({
                    where: { id: userId, isActive: true, deletedAt: null },
                    select: { globalRole: true },
                });
                if (!user) return work(tx, { userId, id: { in: [] } });
                const organizations = await tx.organization.findMany({
                    where: {
                        ...(user.globalRole === 'SUPER_ADMIN'
                            ? {}
                            : { memberships: { some: { userId } } }),
                    },
                    select: { id: true },
                });
                for (const id of organizations.map(({ id }) => id).sort()) {
                    await lockOrganization(tx, id);
                }
                const memberships = await tx.membership.findMany({
                    where: {
                        userId,
                        organizationId: {
                            in: organizations.map(({ id }) => id),
                        },
                    },
                    select: { id: true },
                });
                await lockMemberships(tx, memberships);
                const projects = await tx.project.findMany({
                    where: {
                        organizationId: {
                            in: organizations.map(({ id }) => id),
                        },
                        deletedAt: null,
                        ...(user.globalRole === 'SUPER_ADMIN'
                            ? {}
                            : {
                                  OR: [
                                      {
                                          organization: {
                                              memberships: {
                                                  some: {
                                                      userId,
                                                      role: {
                                                          in: [
                                                              'OWNER',
                                                              'ADMIN',
                                                          ],
                                                      },
                                                  },
                                              },
                                          },
                                      },
                                      {
                                          memberships: {
                                              some: {
                                                  membershipId: {
                                                      in: memberships.map(
                                                          ({ id }) => id,
                                                      ),
                                                  },
                                              },
                                          },
                                      },
                                  ],
                              }),
                    },
                    select: { id: true },
                });
                await lockProjects(
                    tx,
                    projects.map(({ id }) => id),
                );
                const visible = await this.visibleWhere(userId, tx);
                return work(tx, {
                    AND: [
                        visible,
                        {
                            OR: [
                                {
                                    accessScope: {
                                        in: ['ACCOUNT', 'INVITATION'],
                                    },
                                },
                                {
                                    accessScope: 'ORGANIZATION',
                                    organizationId: {
                                        in: organizations.map(({ id }) => id),
                                    },
                                },
                                {
                                    accessScope: 'PROJECT',
                                    projectId: {
                                        in: projects.map(({ id }) => id),
                                    },
                                },
                            ],
                        },
                    ],
                });
            }),
        );
    }

    async visibleWhere(
        userId: string,
        db: NotificationDb = this.prisma,
    ): Promise<Prisma.NotificationWhereInput> {
        const user = await db.user.findFirst({
            where: { id: userId, isActive: true, deletedAt: null },
            select: { email: true, globalRole: true },
        });
        if (!user) return { userId, id: { in: [] } };
        const memberships = await db.membership.findMany({
            where: { userId, organization: { deletedAt: null } },
            select: { organizationId: true, role: true },
        });
        const projects = await db.project.findMany({
            where: {
                deletedAt: null,
                organization: { deletedAt: null },
                ...(user.globalRole === 'SUPER_ADMIN'
                    ? {}
                    : {
                          OR: [
                              {
                                  organization: {
                                      memberships: {
                                          some: {
                                              userId,
                                              role: { in: ['OWNER', 'ADMIN'] },
                                          },
                                      },
                                  },
                              },
                              {
                                  memberships: {
                                      some: {
                                          // ProjectMembership has no
                                          // `organization` relation (its
                                          // organizationId is bound to the
                                          // project by a composite FK), so the
                                          // deleted-organization guard lives on
                                          // `organization` above.
                                          membership: { userId },
                                      },
                                  },
                              },
                          ],
                      }),
            },
            select: { id: true, organizationId: true },
        });
        const invitations = await db.invitation.findMany({
            where: {
                email: { equals: user.email, mode: 'insensitive' },
                organization: { deletedAt: null },
            },
            select: { id: true },
        });
        return {
            userId,
            OR: [
                { accessScope: 'ACCOUNT' },
                {
                    accessScope: 'INVITATION',
                    resourceType: 'Invitation',
                    resourceId: { in: invitations.map(({ id }) => id) },
                },
                {
                    accessScope: 'ORGANIZATION',
                    organizationId: {
                        in: memberships.map(
                            ({ organizationId }) => organizationId,
                        ),
                    },
                    OR: [
                        { type: { notIn: ADMIN_NOTIFICATION_TYPES } },
                        {
                            organizationId: {
                                in: memberships
                                    .filter(({ role }) =>
                                        ADMIN_ROLES.includes(role),
                                    )
                                    .map(
                                        ({ organizationId }) => organizationId,
                                    ),
                            },
                        },
                    ],
                },
                ...projects.map((project) => ({
                    accessScope: 'PROJECT' as const,
                    projectId: project.id,
                    organizationId: project.organizationId,
                })),
            ],
        };
    }

    async eligible(
        audience: NotificationAudience | undefined,
        db: NotificationDb = this.prisma,
        email = false,
    ): Promise<boolean> {
        if (
            !audience ||
            !['ACCOUNT', 'INVITATION', 'ORGANIZATION', 'PROJECT'].includes(
                audience.accessScope,
            )
        )
            return false;
        const user = audience.userId
            ? await db.user.findFirst({
                  where: {
                      id: audience.userId,
                      isActive: true,
                      deletedAt: null,
                      ...(email ? { emailVerified: true } : {}),
                  },
                  select: { id: true, email: true },
              })
            : null;
        if (audience.userId && !user) return false;
        if (
            email &&
            user &&
            audience.email &&
            user.email.toLowerCase() !== audience.email.toLowerCase()
        )
            return false;
        if (audience.accessScope === 'ACCOUNT') return !!user;
        if (audience.accessScope === 'INVITATION') {
            if (
                !audience.invitationId ||
                !audience.organizationId ||
                !audience.email
            )
                return false;
            if (
                user &&
                user.email.toLowerCase() !== audience.email.toLowerCase()
            )
                return false;
            return !!(await db.invitation.findFirst({
                where: {
                    id: audience.invitationId,
                    organizationId: audience.organizationId,
                    email: { equals: audience.email, mode: 'insensitive' },
                    ...(email
                        ? { status: 'PENDING', expiresAt: { gt: new Date() } }
                        : {}),
                    organization: { deletedAt: null },
                },
                select: { id: true },
            }));
        }
        if (!user || !audience.organizationId) return false;
        if (audience.accessScope === 'ORGANIZATION') {
            if (
                email &&
                audience.monitorCapacityCycleId &&
                audience.monitorCapacityStateKey
            ) {
                const current = await db.monitorCapacityCycle.findFirst({
                    where: {
                        id: audience.monitorCapacityCycleId,
                        organizationId: audience.organizationId,
                    },
                });
                if (
                    !current ||
                    capacityStateKey(current) !==
                        audience.monitorCapacityStateKey
                )
                    return false;
                const released = audience.monitorCapacityReleasedIds;
                if (
                    released?.length &&
                    (await db.monitor.count({
                        where: {
                            organizationId: audience.organizationId,
                            id: { in: released },
                            deletedAt: null,
                            OR: [
                                { quotaGraceEndsAt: null },
                                { quotaGraceEndsAt: { gt: new Date() } },
                            ],
                        },
                    })) !== released.length
                )
                    return false;
            }
            if (
                email &&
                audience.monitorCapacityStage ===
                    'MONITOR_CAPACITY_GRACE_ENDING' &&
                audience.monitorCapacityDeadline
            ) {
                const deadline = new Date(audience.monitorCapacityDeadline);
                if (
                    !(deadline > new Date()) ||
                    !(await db.monitor.count({
                        where: {
                            organizationId: audience.organizationId,
                            deletedAt: null,
                            enabled: true,
                            quotaGraceEndsAt: deadline,
                        },
                    }))
                )
                    return false;
            }
            if (
                email &&
                audience.monitorCapacityCycleId &&
                audience.monitorCapacityStage !== 'MONITOR_CAPACITY_RESTORED'
            ) {
                const cycle = await db.monitorCapacityCycle.findFirst({
                    where: {
                        id: audience.monitorCapacityCycleId,
                        organizationId: audience.organizationId,
                        status: { in: ['GRACE', 'LIMITED'] },
                        ...(audience.monitorCapacityStage ===
                        'MONITOR_CAPACITY_LIMITED'
                            ? { restrictedMonitorIds: { isEmpty: false } }
                            : { graceEndsAt: { gt: new Date() } }),
                    },
                    select: { id: true },
                });
                if (!cycle) return false;
            }
            return !!(await db.membership.findFirst({
                where: {
                    userId: user.id,
                    organizationId: audience.organizationId,
                    ...(audience.organizationRoles
                        ? { role: { in: audience.organizationRoles } }
                        : {}),
                    organization: { deletedAt: null },
                },
                select: { id: true },
            }));
        }
        if (!audience.projectId) return false;
        // Membership is mandatory for recipients, even platform users.
        return !!(await db.membership.findFirst({
            where: {
                ...this.access.projectMemberFilter(
                    audience.organizationId,
                    audience.projectId,
                    audience.minimumRole === 'MEMBER',
                ),
                userId: user.id,
                organization: { deletedAt: null },
                AND: {
                    organization: {
                        projects: {
                            some: { id: audience.projectId, deletedAt: null },
                        },
                    },
                },
            },
            select: { id: true },
        }));
    }
}
