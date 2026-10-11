import type { PrismaService } from '../../../infra/database/prisma.service';
import type { NotificationsService } from '../../notifications/notifications.service';
import { TaskDueSoonService } from './task-due-soon.service';

const taskRow = {
    id: 'task-1',
    organizationId: 'org',
    assignedToId: 'user-2',
    number: 7,
    title: 'Ship monitoring',
    dueDate: new Date('2026-10-07T09:00:00.000Z'),
    project: { key: 'BEA' },
    assignedTo: { id: 'user-2', name: 'Bob', email: 'bob@example.com' },
    watchers: [{ userId: 'user-3' }],
};

function createService() {
    let inTransaction = false;
    const tx = {
        task: { updateMany: jest.fn() },
        user: { findFirst: jest.fn().mockResolvedValue(taskRow.assignedTo) },
    };
    const prisma = {
        task: { findMany: jest.fn() },
        $transaction: jest.fn().mockImplementation(async (callback) => {
            inTransaction = true;
            try {
                return await callback(tx);
            } finally {
                inTransaction = false;
            }
        }),
    };
    const notificationsService = {
        taskRecipients: jest.fn().mockResolvedValue(['user-2', 'user-3']),
        publish: jest.fn().mockImplementation((_event, client) => {
            expect(inTransaction).toBe(true);
            expect(client).toBe(tx);
            return Promise.resolve();
        }),
        enqueueEmail: jest
            .fn()
            .mockImplementation((_template, _payload, _key, client) => {
                expect(inTransaction).toBe(true);
                expect(client).toBe(tx);
                return Promise.resolve();
            }),
    };
    const registry = { register: jest.fn() };

    return {
        service: new TaskDueSoonService(
            prisma as unknown as PrismaService,
            notificationsService as unknown as NotificationsService,
            registry as never,
        ),
        prisma,
        notificationsService,
        tx,
        registry,
    };
}

describe('TaskDueSoonService', () => {
    it('only looks at tasks that were not reminded yet', async () => {
        const { service, prisma } = createService();
        prisma.task.findMany.mockResolvedValue([]);

        await service.handleTaskDueSoon();

        expect(prisma.task.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    dueSoonNotifiedAt: null,
                    status: { notIn: ['DONE', 'CANCELLED'] },
                }),
            }),
        );
    });

    it('claims the task before reminding watchers and the assignee', async () => {
        const { service, prisma, tx, notificationsService } = createService();
        prisma.task.findMany.mockResolvedValue([taskRow]);
        tx.task.updateMany.mockResolvedValue({ count: 1 });

        await service.handleTaskDueSoon();

        expect(tx.task.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'task-1',
                dueSoonNotifiedAt: null,
                dueDate: taskRow.dueDate,
                assignedToId: 'user-2',
                deletedAt: null,
                status: { notIn: ['DONE', 'CANCELLED'] },
            },
            data: { dueSoonNotifiedAt: expect.any(Date) },
        });
        expect(notificationsService.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'TASK_DUE_SOON',
                recipients: ['user-2', 'user-3'],
                eventKey: `task:task-1:due-soon:${taskRow.dueDate.toISOString()}`,
                organizationId: 'org',
            }),
            tx,
        );
        expect(notificationsService.enqueueEmail).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ to: 'bob@example.com' }),
            `task:task-1:due-soon:${taskRow.dueDate.toISOString()}:email:user-2`,
            tx,
            { userId: 'user-2', organizationId: 'org' },
        );
        expect(notificationsService.taskRecipients).toHaveBeenCalledWith(
            'task-1',
            tx,
        );
    });

    it('stays silent when another replica already claimed the reminder', async () => {
        const { service, prisma, tx, notificationsService } = createService();
        prisma.task.findMany.mockResolvedValue([taskRow]);
        tx.task.updateMany.mockResolvedValue({ count: 0 });

        await service.handleTaskDueSoon();

        expect(notificationsService.publish).not.toHaveBeenCalled();
        expect(notificationsService.enqueueEmail).not.toHaveBeenCalled();
    });

    it('includes an assignee even without watchers', async () => {
        const { service, prisma, tx, notificationsService } = createService();
        prisma.task.findMany.mockResolvedValue([{ ...taskRow, watchers: [] }]);
        tx.task.updateMany.mockResolvedValue({ count: 1 });
        notificationsService.taskRecipients.mockResolvedValue(['user-2']);
        await service.handleTaskDueSoon();
        expect(
            notificationsService.publish.mock.calls[0][0].recipients,
        ).toEqual(['user-2']);
        expect(notificationsService.enqueueEmail).toHaveBeenCalledTimes(1);
    });

    it('does not email an assignee who is no longer a current member', async () => {
        const { service, prisma, tx, notificationsService } = createService();
        prisma.task.findMany.mockResolvedValue([taskRow]);
        tx.task.updateMany.mockResolvedValue({ count: 1 });
        notificationsService.taskRecipients.mockResolvedValue(['user-3']);
        await service.handleTaskDueSoon();
        expect(notificationsService.enqueueEmail).not.toHaveBeenCalled();
    });

    it('requires an active, verified current member for durable template email', async () => {
        const { service, prisma, tx, notificationsService } = createService();
        prisma.task.findMany.mockResolvedValue([taskRow]);
        tx.task.updateMany.mockResolvedValue({ count: 1 });
        tx.user.findFirst.mockResolvedValue(null);
        await service.handleTaskDueSoon();
        expect(tx.user.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'user-2',
                isActive: true,
                deletedAt: null,
                emailVerified: true,
                memberships: { some: { organizationId: 'org' } },
            },
            select: { id: true, name: true, email: true },
        });
        expect(notificationsService.enqueueEmail).not.toHaveBeenCalled();
    });

    it('keeps the same event key for retries of one due date', async () => {
        const { service, prisma, tx, notificationsService } = createService();
        prisma.task.findMany.mockResolvedValue([taskRow]);
        tx.task.updateMany.mockResolvedValue({ count: 1 });
        await service.handleTaskDueSoon();
        await service.handleTaskDueSoon();
        expect(notificationsService.publish.mock.calls[0][0].eventKey).toBe(
            notificationsService.publish.mock.calls[1][0].eventKey,
        );
    });

    it('propagates publish failure out of the claim transaction', async () => {
        const { service, prisma, tx, notificationsService } = createService();
        prisma.task.findMany.mockResolvedValue([taskRow]);
        tx.task.updateMany.mockResolvedValue({ count: 1 });
        notificationsService.publish.mockRejectedValue(
            new Error('Outbox unavailable'),
        );
        await service.handleTaskDueSoon();
        expect(notificationsService.enqueueEmail).not.toHaveBeenCalled();
        await expect(prisma.$transaction.mock.results[0].value).rejects.toThrow(
            'Outbox unavailable',
        );
    });
});
