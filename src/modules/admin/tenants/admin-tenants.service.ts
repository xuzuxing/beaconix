import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service';
import { AdminTenantEntity } from './entities';
import { randomUUID } from 'node:crypto';
import { NotificationsService } from '../../notifications/notifications.service';
import {
    MembershipRole,
    NotificationType,
} from '../../../generated/prisma/enums';

@Injectable()
export class AdminTenantsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly notifications: NotificationsService,
    ) {}

    /** Explicit cross-tenant query: every organization, including deleted ones. */
    async findAll(): Promise<AdminTenantEntity[]> {
        const organizations = await this.prisma.organization.findMany({
            include: {
                _count: {
                    select: {
                        memberships: true,
                        projects: true,
                        monitors: { where: { deletedAt: null } },
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        return organizations.map((organization) => this.toEntity(organization));
    }

    async findOne(id: string): Promise<AdminTenantEntity> {
        const organization = await this.prisma.organization.findUnique({
            where: { id },
            include: {
                _count: {
                    select: {
                        memberships: true,
                        projects: true,
                        monitors: { where: { deletedAt: null } },
                    },
                },
            },
        });

        if (!organization) {
            throw new NotFoundException('Tenant not found');
        }

        return this.toEntity(organization);
    }

    /** Soft-deletes the tenant, or restores it when already deleted. */
    async toggle(id: string, actorId?: string): Promise<AdminTenantEntity> {
        const organization = await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${id} FOR UPDATE`;
            const existing = await tx.organization.findUnique({
                where: { id },
                select: { id: true, deletedAt: true },
            });

            if (!existing) throw new NotFoundException('Tenant not found');
            const members = await tx.membership.findMany({
                where: { organizationId: id },
                select: { userId: true, role: true },
            });
            const deleting = !existing.deletedAt;

            const updated = await tx.organization.update({
                where: { id },
                data: { deletedAt: deleting ? new Date() : null },
                include: {
                    _count: {
                        select: {
                            memberships: true,
                            projects: true,
                            monitors: { where: { deletedAt: null } },
                        },
                    },
                },
            });
            await this.notifications.publish(
                {
                    eventKey: `admin-tenant-${deleting ? 'deleted' : 'restored'}:${id}:${randomUUID()}`,
                    type: deleting
                        ? NotificationType.ORGANIZATION_DELETED
                        : NotificationType.ORGANIZATION_RESTORED,
                    title: deleting
                        ? 'Your organization was deleted'
                        : 'Your organization was restored',
                    body: deleting
                        ? 'A platform administrator deleted the organization.'
                        : 'A platform administrator restored the organization.',
                    organizationId: id,
                    actorId,
                    includeActor: true,
                    allowOutsideOrg: deleting,
                    resourceType: 'Organization',
                    resourceId: id,
                    recipients: [
                        { userId: updated.ownerId, email: true },
                        ...members.map((member) => ({
                            userId: member.userId,
                            email:
                                member.role === MembershipRole.OWNER ||
                                member.role === MembershipRole.ADMIN,
                        })),
                        ...(actorId ? [actorId] : []),
                    ],
                },
                tx,
            );
            return updated;
        });

        return this.toEntity(organization);
    }

    private toEntity(organization: {
        id: string;
        name: string;
        slug: string;
        ownerId: string;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        _count: {
            memberships: number;
            projects: number;
            monitors: number;
        };
    }): AdminTenantEntity {
        return new AdminTenantEntity({
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            ownerId: organization.ownerId,
            active: organization.deletedAt === null,
            memberCount: organization._count.memberships,
            projectCount: organization._count.projects,
            monitorCount: organization._count.monitors,
            createdAt: organization.createdAt,
            updatedAt: organization.updatedAt,
            deletedAt: organization.deletedAt,
        });
    }
}
