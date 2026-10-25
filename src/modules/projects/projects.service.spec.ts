import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { ProjectAccessService } from '../../common/authorization/project-access.service';

function setup(overrides = {}) {
    const row = {
        id: 'project',
        organizationId: 'org',
        name: 'Beacon',
        status: 'ACTIVE',
        deletedAt: null,
        ...overrides,
    };
    let inTransaction = false;
    const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        user: {
            findFirst: jest.fn().mockResolvedValue({
                globalRole: 'USER',
                platformAuthorityVersion: 0,
            }),
        },
        organization: { findFirst: jest.fn().mockResolvedValue({ id: 'org' }) },
        membership: {
            findMany: jest.fn().mockResolvedValue([{ id: 'membership' }]),
            findUnique: jest.fn().mockResolvedValue({
                id: 'membership',
                role: 'ADMIN',
                projectPermissionsVersion: 0,
            }),
        },
        projectMembership: { findUnique: jest.fn().mockResolvedValue(null) },
        project: {
            findFirst: jest.fn().mockResolvedValue(row),
            update: jest
                .fn()
                .mockImplementation(({ data }) =>
                    Promise.resolve({ ...row, ...data }),
                ),
        },
    };
    const prisma = {
        project: {
            findFirst: jest.fn().mockResolvedValue(row),
            update: jest.fn(),
        },
        $transaction: jest.fn().mockImplementation(async (callback) => {
            inTransaction = true;
            try {
                return await callback(tx);
            } finally {
                inTransaction = false;
            }
        }),
    };
    const notifications = {
        projectRecipients: jest
            .fn()
            .mockResolvedValue(['participant', 'admin']),
        publish: jest.fn().mockImplementation((_event, client) => {
            expect(inTransaction).toBe(true);
            expect(client).toBe(tx);
            return Promise.resolve();
        }),
    };
    return {
        service: new ProjectsService(
            prisma as never,
            notifications as never,
            new ProjectAccessService(prisma as never),
            {
                assertSlugAllowed: jest.fn().mockResolvedValue(undefined),
            } as never,
        ),
        prisma,
        tx,
        notifications,
    };
}

describe('ProjectsService lifecycle notifications', () => {
    it.each([
        ['archive', 'PROJECT_ARCHIVED', {}],
        ['softDelete', 'PROJECT_DELETED', {}],
        ['restore', 'PROJECT_RESTORED', { deletedAt: new Date() }],
    ] as const)(
        'publishes %s atomically to project participants and admins',
        async (method, type, row) => {
            const { service, notifications, prisma, tx } = setup(row);
            await service[method]('org', 'project', 'actor');
            expect(notifications.projectRecipients).toHaveBeenCalledWith(
                'project',
                tx,
            );
            expect(notifications.publish).toHaveBeenCalledWith(
                expect.objectContaining({
                    type,
                    organizationId: 'org',
                    actorId: 'actor',
                    resourceType: 'Project',
                    resourceId: 'project',
                    recipients: ['participant', 'admin'],
                }),
                tx,
            );
            expect(prisma.project.update).not.toHaveBeenCalled();
        },
    );

    it('resolves deletion recipients before hiding the project', async () => {
        const { service, tx, notifications } = setup();
        await service.softDelete('org', 'project', 'actor');
        expect(
            notifications.projectRecipients.mock.invocationCallOrder[0],
        ).toBeLessThan(tx.project.update.mock.invocationCallOrder[0]);
    });

    it('rejects an already-applied archive from the locked snapshot', async () => {
        const { service, tx, notifications } = setup();
        tx.project.findFirst.mockResolvedValue({
            id: 'project',
            organizationId: 'org',
            status: 'ARCHIVED',
        });
        await expect(
            service.archive('org', 'project', 'actor'),
        ).rejects.toThrow('already archived');
        expect(notifications.publish).not.toHaveBeenCalled();
        expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            tx.project.findFirst.mock.invocationCallOrder[0],
        );
    });

    it('resolves restore recipients after restoring the project', async () => {
        const { service, tx, notifications } = setup({ deletedAt: new Date() });
        await service.restore('org', 'project', 'actor');
        expect(tx.project.update.mock.invocationCallOrder[0]).toBeLessThan(
            notifications.projectRecipients.mock.invocationCallOrder[0],
        );
    });

    it.each([
        ['archive', { status: 'ARCHIVED' }],
        ['restore', {}],
    ] as const)('does not notify a rejected no-op %s', async (method, row) => {
        const { service, notifications } = setup(row);
        await expect(
            service[method]('org', 'project', 'actor'),
        ).rejects.toThrow();
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it('leaves ordinary project title/description edits silent', async () => {
        const { service, notifications, prisma, tx } = setup();
        prisma.project.update.mockResolvedValue({
            id: 'project',
            name: 'Renamed',
        });
        await service.update('org', 'project', 'actor', {
            name: 'Renamed',
            description: 'New body',
        });
        expect(notifications.publish).not.toHaveBeenCalled();
        const projectLock = tx.$queryRaw.mock.calls.find((call) =>
            (call[0] as { sql?: string }).sql?.includes('"projects"'),
        );
        expect((projectLock?.[0] as { sql: string }).sql).toContain(
            'FOR UPDATE',
        );
        expect((projectLock?.[0] as { sql: string }).sql).not.toContain(
            'FOR SHARE',
        );
    });

    it('propagates publication failure so the lifecycle transaction fails', async () => {
        const { service, notifications } = setup();
        notifications.publish.mockRejectedValue(
            new Error('Outbox unavailable'),
        );
        await expect(
            service.archive('org', 'project', 'actor'),
        ).rejects.toThrow('Outbox unavailable');
    });
});

describe('ProjectsController notification actors', () => {
    it.each([
        ['archive', 'archive'],
        ['remove', 'softDelete'],
        ['restore', 'restore'],
    ] as const)(
        'forwards the authenticated actor for %s',
        async (method, serviceMethod) => {
            const service = { [serviceMethod]: jest.fn() };
            const controller = new ProjectsController(service as never);
            await controller[method]('org', 'project', {
                sub: 'actor',
            } as never);
            expect(service[serviceMethod]).toHaveBeenCalledWith(
                'org',
                'project',
                'actor',
            );
        },
    );
});
