import type { PrismaService } from '../../../infra/database/prisma.service';
import type { EmailService } from '../../email/email.service';
import type { NotificationsService } from '../../notifications/notifications.service';
import { TaskDueSoonService } from './task-due-soon.service';

const taskRow = {
    id: 'task-1',
    number: 7,
    title: 'Ship monitoring',
    dueDate: new Date('2026-10-07T09:00:00.000Z'),
    project: { key: 'BEA' },
    assignedTo: { id: 'user-2', name: 'Bob', email: 'bob@example.com' },
    watchers: [{ userId: 'user-3' }],
};

function createService() {
    const prisma = {
        task: { findMany: jest.fn(), updateMany: jest.fn() },
    };
    const notificationsService = {
        createAndEmitMany: jest.fn().mockResolvedValue(undefined),
    };
    const emailService = { send: jest.fn().mockResolvedValue(undefined) };
    const registry = { register: jest.fn() };

    return {
        service: new TaskDueSoonService(
            prisma as unknown as PrismaService,
            notificationsService as unknown as NotificationsService,
            emailService as unknown as EmailService,
            registry as never,
        ),
        prisma,
        notificationsService,
        emailService,
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
        const { service, prisma, notificationsService, emailService } =
            createService();
        prisma.task.findMany.mockResolvedValue([taskRow]);
        prisma.task.updateMany.mockResolvedValue({ count: 1 });

        await service.handleTaskDueSoon();

        expect(prisma.task.updateMany).toHaveBeenCalledWith({
            where: { id: 'task-1', dueSoonNotifiedAt: null },
            data: { dueSoonNotifiedAt: expect.any(Date) },
        });
        expect(notificationsService.createAndEmitMany).toHaveBeenCalledWith(
            ['user-3'],
            expect.objectContaining({ type: 'TASK_DUE_SOON' }),
        );
        expect(emailService.send).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ to: 'bob@example.com' }),
        );
    });

    it('stays silent when another replica already claimed the reminder', async () => {
        const { service, prisma, notificationsService, emailService } =
            createService();
        prisma.task.findMany.mockResolvedValue([taskRow]);
        prisma.task.updateMany.mockResolvedValue({ count: 0 });

        await service.handleTaskDueSoon();

        expect(notificationsService.createAndEmitMany).not.toHaveBeenCalled();
        expect(emailService.send).not.toHaveBeenCalled();
    });
});
