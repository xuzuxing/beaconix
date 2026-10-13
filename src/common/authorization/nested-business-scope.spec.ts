import { TasksService } from '../../modules/tasks/tasks.service';
import { CommentsService } from '../../modules/comments/comments.service';
import { LabelsService } from '../../modules/labels/labels.service';
import { mockProjectAccess } from './access-test.fixture';

describe('Legacy cross-project relationship read isolation', () => {
    const principal = { type: 'USER' as const, userId: 'user' };

    it('filters task detail subtasks, dependency relations and counts by the authorized project', async () => {
        const db = {
            task: {
                findFirst: jest
                    .fn()
                    .mockResolvedValue({ id: 'task', projectId: 'a' }),
            },
        };
        const service = new TasksService(
            db as never,
            {} as never,
            mockProjectAccess(db, 'org'),
        );
        await service.findOne('a', 'task', principal);
        const include = db.task.findFirst.mock.calls[0][0].include;
        const where = {
            projectId: 'a',
            organizationId: 'org',
            deletedAt: null,
        };
        expect(include.subTasks.where).toEqual(where);
        expect(include._count.select.subTasks.where).toEqual(where);
        expect(include.dependencies.where).toEqual({ dependencyTask: where });
        expect(include.dependents.where).toEqual({ dependentTask: where });
    });

    it.each(['findAll', 'findBacklog'] as const)(
        'scopes %s task rows and subtask counts',
        async (method) => {
            const db = {
                task: {
                    findMany: jest.fn().mockResolvedValue([]),
                    count: jest.fn().mockResolvedValue(0),
                },
            };
            const service = new TasksService(
                db as never,
                {} as never,
                mockProjectAccess(db, 'org'),
            );
            if (method === 'findAll') await service.findAll('a', {}, principal);
            else await service.findBacklog('a', principal);
            const query = db.task.findMany.mock.calls[0][0];
            expect(query.where).toMatchObject({
                projectId: 'a',
                organizationId: 'org',
                deletedAt: null,
            });
            expect(query.include._count.select.subTasks.where).toEqual({
                projectId: 'a',
                organizationId: 'org',
                deletedAt: null,
            });
        },
    );

    it('does not include a foreign-task reply even when its parent relation references an authorized comment', async () => {
        const db = {
            task: {
                findFirst: jest
                    .fn()
                    .mockResolvedValue({ id: 'task', projectId: 'a' }),
            },
            comment: { findMany: jest.fn().mockResolvedValue([]) },
        };
        const service = new CommentsService(
            db as never,
            {} as never,
            mockProjectAccess(db, 'org'),
        );
        await service.findAll('task', principal);
        expect(
            db.comment.findMany.mock.calls[0][0].include.replies.where,
        ).toEqual({ taskId: 'task', deletedAt: null });
    });

    it('does not count other projects legacy uses of a project label', async () => {
        const db = { label: { findMany: jest.fn().mockResolvedValue([]) } };
        const service = new LabelsService(
            db as never,
            mockProjectAccess(db, 'org'),
        );
        await service.findProjectLabels('a', principal);
        expect(
            db.label.findMany.mock.calls[0][0].include._count.select.tasks
                .where,
        ).toEqual({
            task: { projectId: 'a', organizationId: 'org', deletedAt: null },
        });
    });
});
