import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { toIsoString } from '../../../common/utils/date.util';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ScheduledJobRegistry } from '../../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../../infra/scheduler/scheduled-jobs.constants';
import { NotificationsService } from '../../notifications/notifications.service';
import { EmailTemplate } from '../../email/email.types';

/**
 * Detects overdue tasks (dueDate in the past) and notifies watchers + emails assignees.
 * Runs every day at 8:00 AM.
 *
 * NotificationType.TASK_OVERDUE — sent to watchers when a task is past its due date.
 */
@Injectable()
export class TaskOverdueService implements OnModuleInit {
    private readonly logger = new Logger(TaskOverdueService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly notificationsService: NotificationsService,
        private readonly registry: ScheduledJobRegistry,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.taskOverdue,
            pattern: SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.taskOverdue],
            handler: () => this.handleTaskOverdue(),
        });
    }

    async handleTaskOverdue(): Promise<void> {
        const jobStart = Date.now();
        this.logger.log('Starting task overdue check...');

        try {
            const now = new Date();
            const dayStart = new Date(now);
            dayStart.setHours(0, 0, 0, 0);

            const tasks = await this.prisma.task.findMany({
                where: {
                    dueDate: { lt: now },
                    deletedAt: null,
                    status: { notIn: ['DONE', 'CANCELLED'] },
                    // Reminded at most once per day; without this the job would
                    // re-notify every overdue task on every run.
                    OR: [
                        { overdueNotifiedAt: null },
                        { overdueNotifiedAt: { lt: dayStart } },
                    ],
                },
                include: {
                    project: { select: { key: true } },
                },
            });

            this.logger.log(`Found ${tasks.length} overdue task(s)`);

            let notifiedCount = 0;
            let remindedCount = 0;

            for (const task of tasks) {
                // Claim today's reminder before sending: several replicas (or a
                // retried job) must not notify the same task twice in one day.
                await this.prisma.$transaction(async (tx) => {
                    const { count } = await tx.task.updateMany({
                        where: {
                            id: task.id,
                            dueDate: task.dueDate,
                            assignedToId: task.assignedToId,
                            deletedAt: null,
                            status: { notIn: ['DONE', 'CANCELLED'] },
                            OR: [
                                { overdueNotifiedAt: null },
                                { overdueNotifiedAt: { lt: dayStart } },
                            ],
                        },
                        data: { overdueNotifiedAt: now },
                    });
                    if (count === 0) return;
                    const recipients =
                        await this.notificationsService.taskRecipients(
                            task.id,
                            tx,
                        );
                    const eventKey = `task:${task.id}:overdue:${toIsoString(task.dueDate!)}:${toIsoString(dayStart)}`;
                    await this.notificationsService.publish(
                        {
                            eventKey,
                            type: 'TASK_OVERDUE',
                            title: `Task ${task.project.key}-${task.number} is overdue`,
                            body: `"${task.title}" was due ${toIsoString(task.dueDate!)}`,
                            organizationId: task.organizationId,
                            resourceType: 'Task',
                            resourceId: task.id,
                            recipients,
                        },
                        tx,
                    );
                    const assignee =
                        task.assignedToId &&
                        recipients.includes(task.assignedToId)
                            ? await tx.user.findFirst({
                                  where: {
                                      id: task.assignedToId,
                                      isActive: true,
                                      deletedAt: null,
                                      emailVerified: true,
                                      memberships: {
                                          some: {
                                              organizationId:
                                                  task.organizationId,
                                          },
                                      },
                                  },
                                  select: { id: true, name: true, email: true },
                              })
                            : null;
                    if (assignee) {
                        await this.notificationsService.enqueueEmail(
                            EmailTemplate.TASK_OVERDUE,
                            {
                                to: assignee.email,
                                name: assignee.name,
                                taskTitle: task.title,
                                taskNumber: task.number,
                                dueDate: toIsoString(task.dueDate!),
                                projectKey: task.project.key,
                            },
                            `${eventKey}:email:${assignee.id}`,
                            tx,
                            {
                                userId: assignee.id,
                                organizationId: task.organizationId,
                            },
                        );
                    }
                    remindedCount += 1;
                    notifiedCount += recipients.length;
                });
            }

            const duration = Date.now() - jobStart;
            this.logger.log(
                `Task overdue check completed in ${duration}ms — ` +
                    `tasks: ${tasks.length}, reminded: ${remindedCount}, ` +
                    `notifications: ${notifiedCount}`,
            );
        } catch (error) {
            const duration = Date.now() - jobStart;
            this.logger.error(
                `Task overdue check failed after ${duration}ms`,
                error instanceof Error ? error.stack : String(error),
            );
        }
    }
}
