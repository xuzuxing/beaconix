import { ProjectAccessService } from './project-access.service';

// Business unit tests isolate this dependency. Guard/ACL tests use the real
// ProjectAccessService with explicit membership and grant fixtures.
export function mockProjectAccess(
    db: any,
    organizationId = 'org-1',
): ProjectAccessService {
    const context = {
        organizationId,
        projectId: 'project',
        effectiveRole: 'ADMIN',
        canManageOrganization: true,
        accessMode: 'ALL_PROJECTS',
    };
    const transact = (work: (tx: any) => Promise<unknown>) =>
        db.$transaction ? db.$transaction(work) : work(db);
    const withProject = jest
        .fn()
        .mockImplementation(
            (_principal, projectId, _action, work, lock = 'SHARE') =>
                transact(async (tx) => {
                    if (tx.$queryRaw) {
                        await tx.$queryRaw`SELECT "id" FROM "projects" WHERE "id" = ${projectId} ${`FOR ${lock}`}`;
                    }
                    return work(tx, { ...context, projectId });
                }),
        );
    return {
        project: jest.fn().mockResolvedValue(context),
        organization: jest.fn().mockResolvedValue(context),
        projectFilter: jest.fn().mockImplementation((_principal, orgId) => ({
            organizationId: orgId,
            deletedAt: null,
        })),
        projectMemberFilter: jest
            .fn()
            .mockImplementation((orgId, projectId, writable) => ({
                organizationId: orgId,
                user: { isActive: true, deletedAt: null },
                OR: [
                    { role: { in: ['OWNER', 'ADMIN'] } },
                    {
                        role: {
                            in: writable ? ['MEMBER'] : ['MEMBER', 'VIEWER'],
                        },
                        projectMemberships: { some: { projectId } },
                    },
                ],
            })),
        withProject,
        withProjectWrite: jest
            .fn()
            .mockImplementation(
                (_principal, orgId, projectId, action, work, lock) =>
                    withProject(
                        _principal,
                        projectId,
                        action,
                        (tx, access) =>
                            work(tx, { ...access, organizationId: orgId }),
                        lock,
                    ),
            ),
        withOrganization: jest
            .fn()
            .mockImplementation((_principal, orgId, work) =>
                transact((tx) =>
                    work(tx, { ...context, organizationId: orgId }),
                ),
            ),
        withTask: jest
            .fn()
            .mockImplementation((_principal, taskId, _action, work) =>
                transact(async (tx) => {
                    const task = await tx.task.findFirst({
                        where: { id: taskId, deletedAt: null },
                    });
                    return work(tx, context, task);
                }),
            ),
        task: jest.fn().mockImplementation(async (_principal, taskId) => ({
            access: context,
            task: await db.task.findFirst({
                where: { id: taskId, deletedAt: null },
            }),
        })),
    } as unknown as ProjectAccessService;
}
