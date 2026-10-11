import { SprintsService } from './sprints.service';
import { SprintsController } from './sprints.controller';

function setup(status = 'PLANNED', creator: string | null = 'project-creator') {
    const sprint = {
        id: 'sprint',
        projectId: 'project',
        name: 'Sprint 1',
        status,
    };
    let inTransaction = false;
    const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        project: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'project',
                organizationId: 'org',
                status: 'ACTIVE',
                createdById: creator,
            }),
        },
        sprint: {
            findFirst: jest
                .fn()
                .mockResolvedValueOnce(sprint)
                .mockResolvedValue(null),
            update: jest.fn().mockImplementation(({ data }) =>
                Promise.resolve({
                    ...sprint,
                    ...data,
                }),
            ),
            delete: jest.fn().mockResolvedValue(sprint),
        },
        task: {
            updateManyAndReturn: jest.fn().mockResolvedValue([
                { id: 'task-1', number: 1 },
                { id: 'task-2', number: 2 },
            ]),
        },
    };
    const prisma = {
        project: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'project',
                organizationId: 'org',
                status: 'ACTIVE',
                createdById: creator,
            }),
        },
        sprint: { findFirst: jest.fn().mockResolvedValue(sprint) },
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
            .mockResolvedValue(['project-participant', 'admin']),
        organizationRecipients: jest.fn().mockResolvedValue(['admin']),
        taskRecipients: jest
            .fn()
            .mockImplementation((id) =>
                Promise.resolve(
                    id === 'task-1' ? ['owner-1', 'watcher-1'] : ['owner-2'],
                ),
            ),
        publish: jest.fn().mockImplementation((_event, client) => {
            expect(inTransaction).toBe(true);
            expect(client).toBe(tx);
            return Promise.resolve();
        }),
    };
    return {
        service: new SprintsService(prisma as never, notifications as never),
        prisma,
        tx,
        notifications,
    };
}

describe('SprintsService collaboration notifications', () => {
    it('uses actual project participants and admins for sprint start', async () => {
        const { service, tx, notifications } = setup();
        await service.start('project', 'sprint', 'actor');
        expect(notifications.projectRecipients).toHaveBeenCalledWith(
            'project',
            tx,
        );
        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                eventKey: 'sprint:sprint:started',
                type: 'SPRINT_STARTED',
                organizationId: 'org',
                actorId: 'actor',
                recipients: ['project-participant', 'admin'],
            }),
            tx,
        );
        expect(notifications.organizationRecipients).not.toHaveBeenCalled();
    });

    it('completes atomically and sends each backlog notice only to that task audience', async () => {
        const { service, tx, notifications } = setup('ACTIVE');
        await service.complete('project', 'sprint', 'actor');
        expect(tx.task.updateManyAndReturn).toHaveBeenCalledWith({
            where: {
                projectId: 'project',
                sprintId: 'sprint',
                deletedAt: null,
                status: { not: 'DONE' },
            },
            data: { sprintId: null },
            select: { id: true, number: true },
        });
        const events = notifications.publish.mock.calls.map(([event]) => event);
        expect(events).toEqual([
            expect.objectContaining({
                type: 'TASK_SPRINT_CHANGED',
                resourceId: 'task-1',
                recipients: ['owner-1', 'watcher-1'],
                actorId: 'actor',
                meta: {
                    previousSprintId: 'sprint',
                    sprintId: null,
                    reason: 'completed',
                },
            }),
            expect.objectContaining({
                type: 'TASK_SPRINT_CHANGED',
                resourceId: 'task-2',
                recipients: ['owner-2'],
            }),
            expect.objectContaining({
                type: 'SPRINT_COMPLETED',
                recipients: ['project-participant', 'admin'],
            }),
        ]);
        expect(notifications.organizationRecipients).not.toHaveBeenCalled();
    });

    it('notifies impacted participants and admins on removal, with task-specific backlog notices', async () => {
        const { service, notifications, tx } = setup('COMPLETED');
        await service.remove('project', 'sprint', 'actor');
        expect(
            tx.task.updateManyAndReturn.mock.calls[0][0].where,
        ).not.toHaveProperty('status');
        expect(tx.sprint.delete).toHaveBeenCalledWith({
            where: { id: 'sprint' },
        });
        const events = notifications.publish.mock.calls.map(([event]) => event);
        expect(events[0]).toMatchObject({
            type: 'TASK_SPRINT_CHANGED',
            resourceId: 'task-1',
            recipients: ['owner-1', 'watcher-1'],
        });
        expect(events[1]).toMatchObject({
            type: 'TASK_SPRINT_CHANGED',
            resourceId: 'task-2',
            recipients: ['owner-2'],
        });
        expect(events[2]).toMatchObject({
            type: 'SPRINT_DELETED',
            resourceType: 'Project',
            resourceId: 'project',
            recipients: [
                'owner-1',
                'watcher-1',
                'owner-2',
                'project-creator',
                'admin',
            ],
        });
        expect(notifications.organizationRecipients).toHaveBeenCalledWith(
            'org',
            tx,
            ['OWNER', 'ADMIN'],
        );
    });

    it('filters a deleted project creator rather than publishing a null recipient', async () => {
        const { service, notifications } = setup('COMPLETED', null);
        await service.remove('project', 'sprint', 'actor');
        const event = notifications.publish.mock.calls[2][0];
        expect(event.recipients).not.toContain(null);
    });

    it('does not publish task movements when there are no affected tasks', async () => {
        const { service, tx, notifications } = setup('ACTIVE');
        tx.task.updateManyAndReturn.mockResolvedValue([]);
        await service.complete('project', 'sprint', 'actor');
        expect(notifications.publish).toHaveBeenCalledTimes(1);
        expect(notifications.publish.mock.calls[0][0].type).toBe(
            'SPRINT_COMPLETED',
        );
    });

    it.each([
        ['start', 'ACTIVE'],
        ['complete', 'COMPLETED'],
        ['remove', 'ACTIVE'],
    ] as const)(
        'does not publish rejected/no-op %s',
        async (method, status) => {
            const { service, notifications } = setup(status);
            await expect(
                service[method]('project', 'sprint', 'actor'),
            ).rejects.toThrow();
            expect(notifications.publish).not.toHaveBeenCalled();
        },
    );

    it('does not allow movement publication failures to commit sprint completion', async () => {
        const { service, notifications } = setup('ACTIVE');
        notifications.publish.mockRejectedValue(
            new Error('Outbox unavailable'),
        );
        await expect(
            service.complete('project', 'sprint', 'actor'),
        ).rejects.toThrow('Outbox unavailable');
    });
});

describe('SprintsController notification actors', () => {
    it.each(['start', 'complete', 'remove'] as const)(
        'forwards the authenticated actor for %s',
        async (method) => {
            const service = { [method]: jest.fn() };
            const controller = new SprintsController(service as never);
            await controller[method]('project', 'sprint', {
                sub: 'actor',
            } as never);
            expect(service[method]).toHaveBeenCalledWith(
                'project',
                'sprint',
                'actor',
            );
        },
    );
});
