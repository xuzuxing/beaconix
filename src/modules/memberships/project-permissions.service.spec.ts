import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
import { ProjectPermissionsService } from './project-permissions.service';

function setup() {
    let version = 3;
    let rows = [
        {
            projectId: 'old-project',
            role: 'ADMIN',
            project: { name: 'Old', deletedAt: new Date() },
        },
    ];
    const membership = {
        id: 'current-membership',
        userId: 'target',
        role: 'MEMBER',
        organizationId: 'org',
    };
    const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        membership: {
            findMany: jest.fn().mockResolvedValue([
                { id: 'actor-membership', userId: 'actor' },
                { id: membership.id, userId: 'target' },
            ]),
            findUnique: jest.fn().mockImplementation(({ include }) =>
                Promise.resolve({
                    ...membership,
                    projectPermissionsVersion: version,
                    ...(include
                        ? {
                              projectMemberships: rows.filter(
                                  (row) => !row.project.deletedAt,
                              ),
                          }
                        : {}),
                }),
            ),
            update: jest.fn().mockImplementation(() => {
                version++;
                return Promise.resolve({
                    ...membership,
                    projectPermissionsVersion: version,
                });
            }),
        },
        project: {
            findMany: jest.fn().mockResolvedValue([{ id: 'new-project' }]),
        },
        projectMembership: {
            findMany: jest.fn().mockImplementation(() =>
                Promise.resolve(
                    rows.map(({ projectId, role }) => ({
                        projectId,
                        role,
                    })),
                ),
            ),
            deleteMany: jest.fn().mockImplementation(() => {
                rows = [];
                return Promise.resolve({ count: 1 });
            }),
            createMany: jest.fn().mockImplementation(({ data }) => {
                rows = data.map((row) => ({
                    ...row,
                    project: { name: 'New', deletedAt: null },
                }));
                return Promise.resolve({ count: data.length });
            }),
        },
        auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit' }) },
    };
    const db = {
        ...tx,
        $transaction: jest.fn().mockImplementation((work) => work(tx)),
    };
    const access = {
        organization: jest.fn().mockResolvedValue({
            canManageOrganization: true,
            canGrantOrganizationAdmin: false,
        }),
        project: jest.fn().mockResolvedValue({
            organizationId: 'org',
            effectiveRole: 'VIEWER',
            projectStatus: 'ACTIVE',
            canManageOrganization: false,
        }),
    };
    const service = new ProjectPermissionsService(db as never, access as never);
    const dto = {
        expectedMembershipId: membership.id,
        expectedVersion: 3,
        projects: [{ projectId: 'new-project', role: 'VIEWER' as const }],
    };
    return { service, tx, db, access, dto, membership };
}
describe('Atomic project permission replacement', () => {
    it('replaces grants, increments the version and audits even hidden deleted-project grants', async () => {
        const { service, tx, dto } = setup();
        await expect(
            service.replace('org', 'target', 'actor', dto),
        ).resolves.toMatchObject({
            membershipId: 'current-membership',
            projectPermissionsVersion: 4,
            projects: [{ assignedRole: 'VIEWER', effectiveRole: 'VIEWER' }],
        });
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                entity: 'ProjectPermissions',
                before: {
                    targetUserId: 'target',
                    membershipId: 'current-membership',
                    projectPermissionsVersion: 3,
                    projects: [{ projectId: 'old-project', role: 'ADMIN' }],
                },
                after: expect.objectContaining({
                    projectPermissionsVersion: 4,
                }),
            }),
        });
        expect(tx.membership.update.mock.invocationCallOrder[0]).toBeLessThan(
            tx.auditLog.create.mock.invocationCallOrder[0],
        );
    });
    it.each([
        { expectedMembershipId: 'previous-incarnation', expectedVersion: 3 },
        { expectedMembershipId: 'current-membership', expectedVersion: 2 },
    ])(
        'rejects stale preconditions without grant/version/audit writes: %s',
        async (preconditions) => {
            const { service, tx, dto } = setup();
            await expect(
                service.replace('org', 'target', 'actor', {
                    ...dto,
                    ...preconditions,
                }),
            ).rejects.toThrow(ConflictException);
            expect(tx.projectMembership.deleteMany).not.toHaveBeenCalled();
            expect(tx.membership.update).not.toHaveBeenCalled();
            expect(tx.auditLog.create).not.toHaveBeenCalled();
        },
    );
    it('allows empty replacements to revoke everything without inheritance', async () => {
        const { service, tx, dto } = setup();
        tx.project.findMany.mockResolvedValue([]);
        await expect(
            service.replace('org', 'target', 'actor', { ...dto, projects: [] }),
        ).resolves.toMatchObject({
            accessMode: 'SELECTED_PROJECTS',
            projects: [],
            projectPermissionsVersion: 4,
        });
        expect(tx.projectMembership.createMany).not.toHaveBeenCalled();
    });
    it.each(['OWNER', 'ADMIN'])(
        'cannot constrain organization %s',
        async (role) => {
            const { service, membership, dto, tx } = setup();
            membership.role = role;
            await expect(
                service.replace('org', 'target', 'actor', dto),
            ).rejects.toThrow(BadRequestException);
            expect(tx.projectMembership.deleteMany).not.toHaveBeenCalled();
        },
    );
    it('rejects missing members and nonadministrative actors', async () => {
        const first = setup();
        first.tx.membership.findUnique.mockResolvedValue(null);
        await expect(
            first.service.replace('org', 'target', 'actor', first.dto),
        ).rejects.toThrow(NotFoundException);
        const second = setup();
        second.access.organization.mockResolvedValue({
            canManageOrganization: false,
        });
        await expect(
            second.service.replace('org', 'target', 'actor', second.dto),
        ).rejects.toThrow(ForbiddenException);
        expect(second.tx.projectMembership.deleteMany).not.toHaveBeenCalled();
    });
    it('rejects viewer escalation and invalid project parents before mutation', async () => {
        const viewer = setup();
        viewer.membership.role = 'VIEWER';
        await expect(
            viewer.service.replace('org', 'target', 'actor', {
                ...viewer.dto,
                projects: [{ projectId: 'new-project', role: 'ADMIN' }],
            }),
        ).rejects.toThrow(BadRequestException);
        const invalid = setup();
        invalid.tx.project.findMany.mockResolvedValue([]);
        await expect(
            invalid.service.replace('org', 'target', 'actor', invalid.dto),
        ).rejects.toThrow(BadRequestException);
        expect(invalid.tx.projectMembership.deleteMany).not.toHaveBeenCalled();
    });
    it('propagates audit failures through the same transaction callback', async () => {
        const { service, tx, dto, db } = setup();
        tx.auditLog.create.mockRejectedValue(new Error('audit unavailable'));
        await expect(
            service.replace('org', 'target', 'actor', dto),
        ).rejects.toThrow('audit unavailable');
        expect(db.$transaction).toHaveBeenCalledTimes(1);
    });
    it('rejects omitted optimistic preconditions instead of substituting current values', async () => {
        const { service, db, dto } = setup();
        await expect(
            service.replace('org', 'target', 'actor', {
                ...dto,
                expectedVersion: undefined,
            } as never),
        ).rejects.toThrow(BadRequestException);
        expect(db.$transaction).not.toHaveBeenCalled();
    });
    it('only allows administrators or the target to read member grants', async () => {
        const { service, access } = setup();
        access.organization.mockResolvedValue({
            canManageOrganization: false,
        });
        await expect(
            service.findMemberPermissions('org', 'target', 'actor'),
        ).rejects.toThrow(ForbiddenException);
        await expect(
            service.findMemberPermissions('org', 'target', 'target'),
        ).resolves.toMatchObject({ projects: [] });
    });
});
