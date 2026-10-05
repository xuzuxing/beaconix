import { NotFoundException } from '@nestjs/common';
import { AdminTenantsService } from './admin-tenants.service';
import type { PrismaService } from '../../../infra/database/prisma.service';

const orgRow = {
    id: 'org-1',
    name: 'Acme Corporation',
    slug: 'acme-corp',
    ownerId: 'user-1',
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
    deletedAt: null,
    _count: { memberships: 3, projects: 2, monitors: 8 },
};

function createService() {
    const prisma = {
        organization: {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
        },
    };

    const service = new AdminTenantsService(prisma as unknown as PrismaService);

    return { service, prisma };
}

describe('AdminTenantsService', () => {
    it('lists every tenant with usage counts', async () => {
        const { service, prisma } = createService();
        prisma.organization.findMany.mockResolvedValue([orgRow]);

        const result = await service.findAll();

        expect(prisma.organization.findMany).toHaveBeenCalledWith({
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
        expect(result[0]).toMatchObject({
            id: 'org-1',
            active: true,
            memberCount: 3,
            projectCount: 2,
            monitorCount: 8,
        });
    });

    it('returns one tenant or throws when missing', async () => {
        const { service, prisma } = createService();
        prisma.organization.findUnique.mockResolvedValue(orgRow);

        await expect(service.findOne('org-1')).resolves.toMatchObject({
            id: 'org-1',
            active: true,
        });

        prisma.organization.findUnique.mockResolvedValue(null);
        await expect(service.findOne('missing')).rejects.toThrow(
            NotFoundException,
        );
    });

    it('soft-deletes an active tenant and restores a deleted one', async () => {
        const { service, prisma } = createService();
        prisma.organization.findUnique.mockResolvedValue({
            id: 'org-1',
            deletedAt: null,
        });
        prisma.organization.update.mockResolvedValue({
            ...orgRow,
            deletedAt: new Date('2026-03-06T12:00:00.000Z'),
        });

        const deleted = await service.toggle('org-1');

        expect(prisma.organization.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: { deletedAt: expect.any(Date) },
            }),
        );
        expect(deleted.active).toBe(false);

        prisma.organization.findUnique.mockResolvedValue({
            id: 'org-1',
            deletedAt: new Date('2026-03-06T12:00:00.000Z'),
        });
        prisma.organization.update.mockResolvedValue(orgRow);

        const restored = await service.toggle('org-1');

        expect(restored.active).toBe(true);
    });
});
