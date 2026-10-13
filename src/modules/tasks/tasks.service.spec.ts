import { mockProjectAccess } from '../../common/authorization/access-test.fixture';
import { dueDateChanged } from './tasks.service';
import { TasksService } from './tasks.service';
import type { NotificationEvent } from '../notifications/notification-event';

const taskRow = {
    id: 'task',
    projectId: 'project',
    organizationId: 'org',
    title: 'Ship a feature',
    number: 7,
    status: 'TODO',
    priority: 'MEDIUM',
    assignedToId: 'old',
    sprintId: 'sprint',
    dueDate: new Date('2026-10-12T09:00:00Z'),
    deletedAt: null as Date | null,
    completedAt: null,
};

function setup(overrides = {}) {
    const existing = { ...taskRow, ...overrides };
    let inTransaction = false;
    const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        task: {
            findFirst: jest.fn().mockResolvedValue(existing),
            findMany: jest.fn().mockResolvedValue([]),
            create: jest.fn().mockImplementation(({ data }) =>
                Promise.resolve({
                    ...existing,
                    ...data,
                    id: 'created-task',
                }),
            ),
            update: jest.fn().mockImplementation(({ data }) =>
                Promise.resolve({
                    ...existing,
                    ...data,
                }),
            ),
        },
        taskWatcher: {
            create: jest.fn().mockResolvedValue({}),
            upsert: jest.fn().mockResolvedValue({}),
        },
        taskActivity: {
            create: jest.fn().mockResolvedValue({}),
            createMany: jest.fn().mockResolvedValue({}),
        },
        taskDependency: {
            create: jest
                .fn()
                .mockResolvedValue({ id: 'dep', dependencyTask: taskRow }),
            delete: jest.fn().mockResolvedValue({}),
        },
    };
    const prisma = {
        task: { findFirst: jest.fn().mockResolvedValue(existing) },
        project: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'project',
                organizationId: 'org',
                status: 'ACTIVE',
            }),
        },
        sprint: { findFirst: jest.fn().mockResolvedValue({ id: 'sprint' }) },
        membership: {
            findUnique: jest.fn().mockResolvedValue({ userId: 'new' }),
        },
        taskDependency: {
            findUnique: jest.fn().mockResolvedValue(null),
            findFirst: jest.fn().mockResolvedValue({
                id: 'dep',
                dependencyTaskId: 'dependency',
            }),
            findMany: jest.fn().mockResolvedValue([]),
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
    Object.assign(tx, {
        sprint: prisma.sprint,
        membership: {
            findFirst: jest.fn().mockResolvedValue({ userId: 'new' }),
        },
    });
    Object.assign(tx.taskDependency, {
        findUnique: prisma.taskDependency.findUnique,
        findFirst: prisma.taskDependency.findFirst,
        findMany: prisma.taskDependency.findMany,
    });
    const notifications = {
        taskRecipients: jest
            .fn()
            .mockResolvedValue(['actor', 'old', 'watcher', 'watcher']),
        publish: jest.fn().mockImplementation((_event, client) => {
            expect(inTransaction).toBe(true);
            expect(client).toBe(tx);
            return Promise.resolve();
        }),
    };
    return {
        service: new TasksService(
            prisma as never,
            notifications as never,
            mockProjectAccess(prisma, 'org'),
        ),
        prisma,
        tx,
        notifications,
        event: (index = 0) =>
            notifications.publish.mock.calls[index][0] as NotificationEvent,
    };
}

describe('TasksService collaboration notifications', () => {
    it('creates an assigned task with an email override and no duplicate recipients', async () => {
        const { service, tx, notifications, event } = setup();
        notifications.taskRecipients.mockResolvedValue([
            'actor',
            'new',
            'watcher',
            'new',
        ]);
        await service.create('project', 'actor', {
            title: 'New task',
            assignedToId: 'new',
        });
        expect(event()).toMatchObject({
            eventKey: 'task:created-task:created',
            type: 'TASK_ASSIGNED',
            organizationId: 'org',
            actorId: 'actor',
            recipients: [
                { userId: 'new', email: true, title: expect.any(String) },
                'watcher',
            ],
        });
        expect(notifications.taskRecipients).toHaveBeenCalledWith(
            'created-task',
            tx,
        );
        expect(tx.taskWatcher.create).toHaveBeenCalledTimes(2);
    });

    it('does not notify on creation without an assignee', async () => {
        const { service, notifications } = setup();
        await service.create('project', 'actor', { title: 'New task' });
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it('excludes a self-assignment actor from creation recipients', async () => {
        const { service, event, tx } = setup();
        await service.create('project', 'actor', {
            title: 'New task',
            assignedToId: 'actor',
        });
        expect(event().recipients).toEqual(['old', 'watcher']);
        expect(tx.taskWatcher.create).toHaveBeenCalledTimes(1);
    });

    it('notifies new and previous assignees ahead of ordinary watchers on transfer', async () => {
        const { service, event, notifications } = setup();
        notifications.taskRecipients.mockResolvedValue([
            'actor',
            'new',
            'old',
            'watcher',
            'watcher',
        ]);
        await service.assign('project', 'task', 'actor', {
            assignedToId: 'new',
        });
        expect(event().recipients).toEqual([
            expect.objectContaining({
                userId: 'new',
                type: 'TASK_ASSIGNED',
                email: true,
            }),
            expect.objectContaining({ userId: 'old', type: 'TASK_UNASSIGNED' }),
            'watcher',
        ]);
        expect(event().meta).toEqual({
            previousAssigneeId: 'old',
            assignedToId: 'new',
        });
    });

    it('notifies the removed assignee even when they are no longer watching', async () => {
        const { service, event, notifications } = setup();
        notifications.taskRecipients.mockResolvedValue(['actor', 'watcher']);
        await service.assign('project', 'task', 'actor', {
            assignedToId: null,
        });
        expect(event()).toMatchObject({
            type: 'TASK_UNASSIGNED',
            recipients: [
                expect.objectContaining({
                    userId: 'old',
                    type: 'TASK_UNASSIGNED',
                }),
                'watcher',
            ],
        });
    });

    it.each([{ assignedToId: 'old' }, { assignedToId: undefined }])(
        'does not publish a no-op assignment %j',
        async (dto) => {
            const { service, notifications } = setup();
            await service.assign('project', 'task', 'actor', dto as never);
            expect(notifications.publish).not.toHaveBeenCalled();
        },
    );

    it('compares assignment against the locked snapshot, not stale prevalidation', async () => {
        const { service, tx, notifications } = setup();
        tx.task.findFirst.mockResolvedValue({
            ...taskRow,
            assignedToId: 'new',
        });
        await service.assign('project', 'task', 'actor', {
            assignedToId: 'new',
        });
        expect(notifications.publish).not.toHaveBeenCalled();
        expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            tx.task.findFirst.mock.invocationCallOrder[0],
        );
    });

    it('targets the actual previous assignee from the transaction snapshot', async () => {
        const { service, tx, notifications, event } = setup();
        tx.task.findFirst.mockResolvedValue({
            ...taskRow,
            assignedToId: 'actual-old',
        });
        notifications.taskRecipients.mockResolvedValue(['watcher']);
        await service.assign('project', 'task', 'actor', {
            assignedToId: 'new',
        });
        expect(event().recipients).toEqual([
            expect.objectContaining({ userId: 'new', type: 'TASK_ASSIGNED' }),
            expect.objectContaining({
                userId: 'actual-old',
                type: 'TASK_UNASSIGNED',
            }),
            'watcher',
        ]);
    });

    it('preserves ordinary edit activities without publishing notifications', async () => {
        const { service, tx, notifications } = setup();
        await service.update('project', 'task', 'actor', {
            title: 'New title',
            description: 'New body',
        });
        expect(tx.taskActivity.createMany).toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it('normalizes equal due dates and leaves reminder markers untouched', async () => {
        const { service, tx, notifications } = setup();
        await service.update('project', 'task', 'actor', {
            dueDate: taskRow.dueDate.toISOString(),
            status: 'TODO',
            priority: 'MEDIUM',
        });
        expect(notifications.publish).not.toHaveBeenCalled();
        expect(tx.taskActivity.createMany).not.toHaveBeenCalled();
        const data = tx.task.update.mock.calls[0][0].data;
        expect(data).not.toHaveProperty('dueSoonNotifiedAt');
        expect(data).not.toHaveProperty('overdueNotifiedAt');
    });

    it.each([
        [{ priority: 'HIGH' }, 'TASK_UPDATED'],
        [{ status: 'IN_PROGRESS' }, 'TASK_STATUS_CHANGED'],
        [{ dueDate: '2026-10-13T09:00:00Z' }, 'TASK_UPDATED'],
        [{ dueDate: null }, 'TASK_UPDATED'],
    ])(
        'publishes meaningful changes %j inside the transaction',
        async (dto, type) => {
            const { service, event, tx } = setup();
            await service.update('project', 'task', 'actor', dto as never);
            expect(event()).toMatchObject({
                type,
                resourceId: 'task',
                recipients: ['old', 'watcher'],
            });
            if ('dueDate' in dto) {
                expect(tx.task.update.mock.calls[0][0].data).toMatchObject({
                    dueSoonNotifiedAt: null,
                    overdueNotifiedAt: null,
                });
            }
        },
    );

    it('only announces newly unblocked active dependents when a dependency completes', async () => {
        const { service, tx, notifications, event } = setup();
        tx.task.findMany.mockResolvedValue([
            { ...taskRow, id: 'dependent', number: 8 },
        ] as never);
        notifications.taskRecipients.mockImplementation((id) =>
            Promise.resolve(
                id === 'dependent' ? ['dependent-owner', 'actor'] : ['watcher'],
            ),
        );
        await service.update('project', 'task', 'actor', { status: 'DONE' });
        expect(tx.task.findMany).toHaveBeenCalledWith({
            where: {
                projectId: 'project',
                deletedAt: null,
                status: { notIn: ['DONE', 'CANCELLED'] },
                dependencies: {
                    some: { dependencyTaskId: 'task' },
                    none: {
                        dependencyTask: {
                            deletedAt: null,
                            status: { not: 'DONE' },
                        },
                    },
                },
            },
        });
        expect(event(1)).toMatchObject({
            type: 'TASK_UNBLOCKED',
            resourceId: 'dependent',
            recipients: ['dependent-owner'],
        });
        expect(event(1).eventKey).toContain(
            `${event().eventKey}:unblocked:dependent`,
        );
        const projectLock = tx.$queryRaw.mock.calls[0];
        expect(projectLock[0].join('')).toContain('FROM "projects"');
        expect(projectLock[1]).toBe('project');
        expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            tx.task.update.mock.invocationCallOrder[0],
        );
    });

    it('does not announce completion again for an already completed task', async () => {
        const { service, tx, notifications } = setup({ status: 'DONE' });
        await service.update('project', 'task', 'actor', { status: 'DONE' });
        expect(tx.task.findMany).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it('captures delete recipients before soft-deleting', async () => {
        const { service, notifications, tx, event } = setup();
        await service.softDelete('project', 'task', 'actor');
        expect(event().type).toBe('TASK_DELETED');
        expect(
            notifications.taskRecipients.mock.invocationCallOrder[0],
        ).toBeLessThan(tx.task.update.mock.invocationCallOrder[0]);
    });

    it('resolves restore recipients after making the task visible', async () => {
        const { service, notifications, tx, event } = setup({
            deletedAt: new Date(),
        });
        await service.restore('project', 'task', 'actor');
        expect(event().type).toBe('TASK_RESTORED');
        expect(tx.task.update.mock.invocationCallOrder[0]).toBeLessThan(
            notifications.taskRecipients.mock.invocationCallOrder[0],
        );
    });

    it.each(['other-sprint', null])(
        'publishes a real sprint/backlog move to %s',
        async (sprintId) => {
            const { service, event } = setup();
            await service.moveToSprint('project', 'task', 'actor', {
                sprintId,
            });
            expect(event()).toMatchObject({
                type: 'TASK_SPRINT_CHANGED',
                meta: { previousSprintId: 'sprint', sprintId },
            });
        },
    );

    it('does not publish for an unchanged sprint', async () => {
        const { service, notifications } = setup();
        await service.moveToSprint('project', 'task', 'actor', {
            sprintId: 'sprint',
        });
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it.each(['added', 'removed'])(
        'publishes dependency %s in the transaction',
        async (action) => {
            const { service, event } = setup();
            if (action === 'added') {
                await service.addDependency('project', 'task', 'actor', {
                    dependencyTaskId: 'dependency',
                });
            } else {
                await service.removeDependency(
                    'project',
                    'task',
                    'dep',
                    'actor',
                );
            }
            expect(event()).toMatchObject({
                type: 'TASK_DEPENDENCY_CHANGED',
                meta: { dependencyTaskId: 'dependency', action },
            });
        },
    );

    it('does not publish a duplicate dependency', async () => {
        const { service, prisma, notifications } = setup();
        prisma.taskDependency.findUnique.mockResolvedValue({
            id: 'dep',
        });
        await expect(
            service.addDependency('project', 'task', 'actor', {
                dependencyTaskId: 'dependency',
            }),
        ).rejects.toThrow('already exists');
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it('propagates publication failures so a mutation cannot commit without its notification', async () => {
        const { service, notifications } = setup();
        notifications.publish.mockRejectedValue(
            new Error('Outbox unavailable'),
        );
        await expect(
            service.assign('project', 'task', 'actor', { assignedToId: 'new' }),
        ).rejects.toThrow('Outbox unavailable');
    });
});

describe('dueDateChanged', () => {
    it('is true when a due date is set, moved or cleared', () => {
        const now = new Date('2026-10-07T09:00:00.000Z');

        expect(dueDateChanged(null, now)).toBe(true);
        expect(dueDateChanged(now, new Date('2026-10-08T09:00:00.000Z'))).toBe(
            true,
        );
        expect(dueDateChanged(now, null)).toBe(true);
    });

    it('is false when the due date stays the same', () => {
        const dueDate = new Date('2026-10-07T09:00:00.000Z');

        expect(dueDateChanged(dueDate, new Date(dueDate.getTime()))).toBe(
            false,
        );
        expect(dueDateChanged(null, null)).toBe(false);
        expect(dueDateChanged(undefined, null)).toBe(false);
    });
});
