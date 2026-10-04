import {
    OrganizationsService,
    DEFAULT_PROJECT_KEY,
    DEFAULT_PROJECT_NAME,
} from './organizations.service';
import type { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';

const user = { id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com' };

function createService() {
    const prisma = {
        membership: { findFirst: jest.fn().mockResolvedValue(null) },
        organization: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({
                id: 'org-1',
                projects: [{ id: 'project-1' }],
            }),
        },
    };

    const service = new OrganizationsService(
        prisma as unknown as PrismaService,
    );

    return { service, prisma };
}

describe('OrganizationsService', () => {
    describe('provisionForUser', () => {
        it('creates an owned organization with a starter project', async () => {
            const { service, prisma } = createService();

            const result = await service.provisionForUser(user);

            expect(result).toEqual({
                organizationId: 'org-1',
                projectId: 'project-1',
            });
            expect(prisma.organization.create).toHaveBeenCalledWith({
                data: {
                    name: "Ada Lovelace's Workspace",
                    slug: 'ada-lovelace',
                    ownerId: 'user-1',
                    memberships: {
                        create: { userId: 'user-1', role: 'OWNER' },
                    },
                    projects: {
                        create: {
                            name: DEFAULT_PROJECT_NAME,
                            key: DEFAULT_PROJECT_KEY,
                            createdById: 'user-1',
                        },
                    },
                },
                include: { projects: { select: { id: true } } },
            });
        });

        it('is idempotent when the user already belongs to an organization', async () => {
            const { service, prisma } = createService();
            prisma.membership.findFirst.mockResolvedValue({
                id: 'membership-1',
            });

            const result = await service.provisionForUser(user);

            expect(result).toBeNull();
            expect(prisma.organization.create).not.toHaveBeenCalled();
        });

        it('uses the supplied transaction client instead of the root client', async () => {
            const { service, prisma } = createService();
            const tx = {
                membership: { findFirst: jest.fn().mockResolvedValue(null) },
                organization: {
                    findUnique: jest.fn().mockResolvedValue(null),
                    create: jest.fn().mockResolvedValue({
                        id: 'org-tx',
                        projects: [{ id: 'project-tx' }],
                    }),
                },
            };

            const result = await service.provisionForUser(
                user,
                tx as unknown as Prisma.TransactionClient,
            );

            expect(result).toEqual({
                organizationId: 'org-tx',
                projectId: 'project-tx',
            });
            expect(prisma.organization.create).not.toHaveBeenCalled();
            expect(tx.organization.create).toHaveBeenCalledTimes(1);
        });
    });

    describe('slug generation', () => {
        it('suffixes the slug when it is already taken', async () => {
            const { service, prisma } = createService();
            prisma.organization.findUnique
                .mockResolvedValueOnce({ id: 'taken' })
                .mockResolvedValue(null);

            await service.provisionForUser(user);

            expect(prisma.organization.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ slug: 'ada-lovelace-2' }),
                }),
            );
        });

        it('falls back to the email local part for non-latin names', async () => {
            const { service, prisma } = createService();

            await service.provisionForUser({
                id: 'user-2',
                name: '张三',
                email: 'Zhang.San@example.com',
            });

            expect(prisma.organization.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ slug: 'zhang-san' }),
                }),
            );
        });

        it('falls back to "workspace" when no slug can be derived', async () => {
            const { service, prisma } = createService();

            await service.provisionForUser({
                id: 'user-3',
                name: '张三',
                email: '李四@example.com',
            });

            expect(prisma.organization.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ slug: 'workspace' }),
                }),
            );
        });
    });

    describe('organization name', () => {
        it('keeps the generated name within the 100 character API limit', async () => {
            const { service, prisma } = createService();

            await service.provisionForUser({
                id: 'user-4',
                name: 'A'.repeat(100),
                email: 'long@example.com',
            });

            const [{ data }] = prisma.organization.create.mock.calls[0] as [
                { data: { name: string } },
            ];

            expect(data.name).toBe(`${'A'.repeat(88)}'s Workspace`);
            expect(data.name).toHaveLength(100);
        });
    });
});
