import {
    ForbiddenException,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { ProjectAccessService } from './project-access.service';
import { ProjectRole, MembershipRole } from '../../generated/prisma/enums';
import { allowsProjectAction, projectCapabilities } from './project-policy';
import type { ProjectAccess } from './access.types';

function setup(
    role: MembershipRole = 'MEMBER',
    grant: ProjectRole | null = 'VIEWER',
) {
    const db = {
        user: {
            findFirst: jest.fn().mockResolvedValue({
                globalRole: 'USER',
                platformAuthorityVersion: 4,
            }),
        },
        organization: { findFirst: jest.fn().mockResolvedValue({ id: 'org' }) },
        membership: {
            findUnique: jest.fn().mockResolvedValue({
                id: 'membership',
                role,
                projectPermissionsVersion: 3,
            }),
        },
        project: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'project',
                organizationId: 'org',
                status: 'ACTIVE',
            }),
        },
        projectMembership: {
            findUnique: jest
                .fn()
                .mockResolvedValue(
                    grant ? { role: grant, organizationId: 'org' } : null,
                ),
        },
        personalAccessToken: {
            findFirst: jest.fn().mockResolvedValue({ id: 'pat' }),
            findUnique: jest.fn().mockResolvedValue({
                scopes: ['monitors:write', 'monitors:read'],
            }),
        },
        apiKey: {
            findFirst: jest.fn().mockResolvedValue({ id: 'key' }),
            findUnique: jest
                .fn()
                .mockResolvedValue({ scopes: ['monitors:read'] }),
        },
    };
    return { service: new ProjectAccessService(db as never), db };
}
const user = { type: 'USER' as const, userId: 'user' };

describe('ProjectAccessService', () => {
    it.each(['MEMBER', 'VIEWER'] as const)(
        'denies %s without explicit grants',
        async (role) => {
            const { service } = setup(role, null);
            await expect(service.project(user, 'project')).rejects.toThrow(
                NotFoundException,
            );
        },
    );
    it.each(['OWNER', 'ADMIN'] as const)(
        'inherits all projects for %s without grants',
        async (role) => {
            const { service } = setup(role, null);
            await expect(
                service.project(user, 'project', 'monitor.manage'),
            ).resolves.toMatchObject({
                effectiveRole: 'ADMIN',
                assignedRole: null,
                accessMode: 'ALL_PROJECTS',
            });
        },
    );
    it('allows a local administrator but denies project deletion', async () => {
        const { service } = setup('MEMBER', 'ADMIN');
        await expect(
            service.project(user, 'project', 'project.manage'),
        ).resolves.toMatchObject({
            effectiveRole: 'ADMIN',
            organizationRole: 'MEMBER',
        });
        await expect(
            service.project(user, 'project', 'project.delete'),
        ).rejects.toThrow(ForbiddenException);
    });
    it('caps legacy high grants for organization viewers', async () => {
        const { service } = setup('VIEWER', 'ADMIN');
        await expect(service.project(user, 'project')).resolves.toMatchObject({
            assignedRole: 'ADMIN',
            effectiveRole: 'VIEWER',
        });
        await expect(
            service.project(user, 'project', 'task.write'),
        ).rejects.toThrow(ForbiddenException);
    });
    it('permits viewer subscriptions but not content changes', async () => {
        const { service } = setup();
        await expect(
            service.project(user, 'project', 'task.subscribe'),
        ).resolves.toBeDefined();
        await expect(
            service.project(user, 'project', 'comment.write'),
        ).rejects.toThrow(ForbiddenException);
    });
    it('requires current database platform authority', async () => {
        const { service, db } = setup('MEMBER', null);
        db.user.findFirst.mockResolvedValue({
            globalRole: 'SUPER_ADMIN',
            platformAuthorityVersion: 4,
        });
        db.membership.findUnique.mockResolvedValue(null);
        await expect(
            service.project(user, 'project', 'project.delete'),
        ).resolves.toMatchObject({ globalRole: 'SUPER_ADMIN' });
        db.user.findFirst.mockResolvedValue({
            globalRole: 'USER',
            platformAuthorityVersion: 5,
        });
        await expect(service.project(user, 'project')).rejects.toThrow(
            NotFoundException,
        );
    });
    it('rejects inactive identities', async () => {
        const { service, db } = setup();
        db.user.findFirst.mockResolvedValue(null);
        await expect(service.project(user, 'project')).rejects.toThrow(
            UnauthorizedException,
        );
    });
    it('checks parent organization before any identity or grant queries', async () => {
        const { service, db } = setup();
        db.project.findFirst.mockResolvedValue(null);
        await expect(
            service.project(user, 'project', 'project.read', 'other-org'),
        ).rejects.toThrow(NotFoundException);
        expect(db.project.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    organizationId: 'other-org',
                    deletedAt: null,
                    organization: { deletedAt: null },
                }),
            }),
        );
        expect(db.user.findFirst).not.toHaveBeenCalled();
    });
    it('filters projects before pagination and never treats no grants as all projects', async () => {
        const { service } = setup('MEMBER', null);
        await expect(service.projectFilter(user, 'org')).resolves.toMatchObject(
            {
                memberships: {
                    some: { membershipId: 'membership', organizationId: 'org' },
                },
            },
        );
    });
    it('denies write scoped PAT with a viewer grant', async () => {
        const { service } = setup();
        await expect(
            service.project(
                { ...user, patId: 'pat' },
                'project',
                'monitor.manage',
            ),
        ).rejects.toThrow(ForbiddenException);
    });
    it('denies a revoked PAT even for current platform administrators', async () => {
        const { service, db } = setup('OWNER');
        db.personalAccessToken.findFirst.mockResolvedValue(null);
        await expect(
            service.project({ ...user, patId: 'pat' }, 'project'),
        ).rejects.toThrow(UnauthorizedException);
    });
    it('does not lend the creator identity to an API key', async () => {
        const { service, db } = setup();
        await expect(
            service.project(
                { type: 'API_KEY', keyId: 'key', organizationId: 'org' },
                'project',
                'monitor.read',
            ),
        ).resolves.toMatchObject({
            membershipId: null,
            globalRole: null,
            canManageOrganization: false,
        });
        expect(db.user.findFirst).not.toHaveBeenCalled();
        expect(db.membership.findUnique).not.toHaveBeenCalled();
        await expect(
            service.project(
                { type: 'API_KEY', keyId: 'key', organizationId: 'org' },
                'project',
                'monitor.manage',
            ),
        ).rejects.toThrow(ForbiddenException);
    });
    it('denies forged system principals', async () => {
        const { service } = setup();
        await expect(
            service.project(
                {
                    type: 'SYSTEM',
                    reason: 'http',
                    authority: Symbol(),
                } as never,
                'project',
            ),
        ).rejects.toThrow(UnauthorizedException);
    });
    it('denies invalid cross-organization grants even when queried by membership', async () => {
        const { service, db } = setup();
        db.projectMembership.findUnique.mockResolvedValue({
            role: 'ADMIN',
            organizationId: 'other',
        });
        await expect(service.project(user, 'project')).rejects.toThrow(
            NotFoundException,
        );
    });
    it('makes archived projects read only, retaining explicit lifecycle actions', async () => {
        const { service, db } = setup('ADMIN');
        db.project.findFirst.mockResolvedValue({
            id: 'project',
            organizationId: 'org',
            status: 'ARCHIVED',
        });
        await expect(service.project(user, 'project')).resolves.toBeDefined();
        await expect(
            service.project(user, 'project', 'monitor.check'),
        ).rejects.toThrow(ForbiddenException);
        await expect(
            service.project(user, 'project', 'project.delete'),
        ).resolves.toBeDefined();
    });
    it('only restore queries deleted projects', async () => {
        const { service, db } = setup('ADMIN');
        await service.project(user, 'project', 'project.restore');
        expect(db.project.findFirst.mock.calls[0][0].where).not.toHaveProperty(
            'deletedAt',
        );
    });
    it('unknown actions fail closed', async () => {
        const { service } = setup('ADMIN');
        const access = await service.project(user, 'project');
        expect(allowsProjectAction(access, 'unrecognized' as never)).toBe(
            false,
        );
        expect(projectCapabilities(access)['task.write']).toBe(true);
        expect(
            allowsProjectAction(
                {
                    ...access,
                    effectiveRole: 'INVALID',
                } as unknown as ProjectAccess,
                'task.write',
            ),
        ).toBe(false);
    });
});
