import type { PrismaService } from '../../../infra/database/prisma.service';
import type { EmailService } from '../../email/email.service';
import type { NotificationsService } from '../../notifications/notifications.service';
import { TaskOverdueService } from './task-overdue.service';

const taskRow = {
    id: 'task-1',
    number: 7,
    title: 'Ship monitoring',
    dueDate: new Date('2026-10-01T09:00:00.000Z'),
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
        service: new TaskOverdueService(
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

describe('TaskOverdueService', () => {
    it('only looks at tasks that were not reminded today', async () => {
        const { service, prisma } = createService();
        prisma.task.findMany.mockResolvedValue([]);

        await service.handleTaskOverdue();

        expect(prisma.task.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    status: { notIn: ['DONE', 'CANCELLED'] },
                    OR: [
                        { overdueNotifiedAt: null },
                        { overdueNotifiedAt: { lt: expect.any(Date) } },
                    ],
                }),
            }),
        );
    });

    it('claims the task before reminding watchers and the assignee', async () => {
        const { service, prisma, notificationsService, emailService } =
            createService();
        prisma.task.findMany.mockResolvedValue([taskRow]);
        prisma.task.updateMany.mockResolvedValue({ count: 1 });

        await service.handleTaskOverdue();

        expect(prisma.task.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'task-1',
                OR: [
                    { overdueNotifiedAt: null },
                    { overdueNotifiedAt: { lt: expect.any(Date) } },
                ],
            },
            data: { overdueNotifiedAt: expect.any(Date) },
        });
        expect(notificationsService.createAndEmitMany).toHaveBeenCalledWith(
            ['user-3'],
            expect.objectContaining({ type: 'TASK_OVERDUE' }),
        );
        expect(emailService.send).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ to: 'bob@example.com' }),
        );
    });

    it("stays silent when another replica already claimed today's reminder", async () => {
        const { service, prisma, notificationsService, emailService } =
            createService();
        prisma.task.findMany.mockResolvedValue([taskRow]);
        prisma.task.updateMany.mockResolvedValue({ count: 0 });

        await service.handleTaskOverdue();

        expect(notificationsService.createAndEmitMany).not.toHaveBeenCalled();
        expect(emailService.send).not.toHaveBeenCalled();
    });
});
