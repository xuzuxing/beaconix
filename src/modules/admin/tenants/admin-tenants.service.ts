import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service';
import { AdminTenantEntity } from './entities';

@Injectable()
export class AdminTenantsService {
    constructor(private readonly prisma: PrismaService) {}

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
    async toggle(id: string): Promise<AdminTenantEntity> {
        const existing = await this.prisma.organization.findUnique({
            where: { id },
            select: { id: true, deletedAt: true },
        });

        if (!existing) {
            throw new NotFoundException('Tenant not found');
        }

        const organization = await this.prisma.organization.update({
            where: { id },
            data: {
                deletedAt: existing.deletedAt ? null : new Date(),
            },
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
