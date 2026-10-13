import { BadRequestException } from '@nestjs/common';
import { TasksService } from '../../modules/tasks/tasks.service';
import { ProjectAccessService } from './project-access.service';

describe('Task assignment with real access policy', () => {
    it.each([
        ['create', 'ungranted'],
        ['create', 'project-viewer'],
        ['create', 'organization-viewer'],
        ['create', 'inactive'],
        ['assign', 'ungranted'],
        ['assign', 'project-viewer'],
        ['assign', 'organization-viewer'],
        ['assign', 'inactive'],
    ])(
        'denies %s to an %s assignee before business writes',
        async (operation, state) => {
            const candidate = {
                role: state === 'organization-viewer' ? 'VIEWER' : 'MEMBER',
                projectRole: state === 'project-viewer' ? 'VIEWER' : 'ADMIN',
                granted: state !== 'ungranted',
                isActive: state !== 'inactive',
            };
            const db = {
                user: {
                    findFirst: jest
                        .fn()
                        .mockResolvedValue({ globalRole: 'USER' }),
                },
                organization: {
                    findFirst: jest.fn().mockResolvedValue({ id: 'org' }),
                },
                project: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: 'project',
                        organizationId: 'org',
                        status: 'ACTIVE',
                    }),
                },
                membership: {
                    findUnique: jest.fn().mockResolvedValue({
                        id: 'actor-membership',
                        role: 'MEMBER',
                    }),
                    findMany: jest
                        .fn()
                        .mockResolvedValue([
                            { id: 'actor-membership' },
                            { id: 'assignee-membership' },
                        ]),
                    findFirst: jest.fn().mockImplementation(({ where }) => {
                        expect(where).toMatchObject({
                            userId: 'assignee',
                            organizationId: 'org',
                            organization: { deletedAt: null },
                            user: { isActive: true, deletedAt: null },
                        });
                        const selected = where.OR[1];
                        expect(selected.projectMemberships.some).toMatchObject({
                            organizationId: 'org',
                            projectId: 'project',
                            project: { deletedAt: null },
                        });
                        const eligible =
                            candidate.isActive &&
                            candidate.granted &&
                            selected.role.in.includes(candidate.role) &&
                            selected.projectMemberships.some.role.in.includes(
                                candidate.projectRole,
                            );
                        return Promise.resolve(
                            eligible ? { id: 'assignee-membership' } : null,
                        );
                    }),
                },
                projectMembership: {
                    findUnique: jest.fn().mockResolvedValue({
                        role: 'MEMBER',
                        organizationId: 'org',
                    }),
                },
                task: { create: jest.fn(), update: jest.fn() },
                auditLog: { create: jest.fn() },
                $queryRaw: jest.fn().mockResolvedValue([]),
                $transaction: jest.fn(),
            };
            db.$transaction.mockImplementation((work) => work(db));
            const notifications = { publishInTransaction: jest.fn() };
            const service = new TasksService(
                db as never,
                notifications as never,
                new ProjectAccessService(db as never),
            );
            const result =
                operation === 'create'
                    ? service.create('project', 'actor', {
                          title: 'Task',
                          assignedToId: 'assignee',
                      })
                    : service.assign('project', 'task', 'actor', {
                          assignedToId: 'assignee',
                      });
            await expect(result).rejects.toThrow(BadRequestException);
            expect(db.membership.findFirst).toHaveBeenCalledTimes(1);
            expect(
                db.membership.findMany.mock.calls[0][0].where.userId.in,
            ).toEqual(['actor', 'assignee']);
            expect(db.task.create).not.toHaveBeenCalled();
            expect(db.task.update).not.toHaveBeenCalled();
            expect(db.auditLog.create).not.toHaveBeenCalled();
            expect(notifications.publishInTransaction).not.toHaveBeenCalled();
        },
    );
});
