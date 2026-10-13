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
 * Alerts watchers and assignees about tasks due within the next 24 hours.
 * Runs every 6 hours to balance timeliness against performance.
 *
 * NotificationType.TASK_DUE_SOON — sent to watchers when due date approaches.
 */
@Injectable()
export class TaskDueSoonService implements OnModuleInit {
    private readonly logger = new Logger(TaskDueSoonService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly notificationsService: NotificationsService,
        private readonly registry: ScheduledJobRegistry,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.taskDueSoon,
            pattern: SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.taskDueSoon],
            handler: () => this.handleTaskDueSoon(),
        });
    }

    async handleTaskDueSoon(): Promise<void> {
        const jobStart = Date.now();
        this.logger.log('Starting task due-soon check...');

        try {
            const now = new Date();
            const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

            const tasks = await this.prisma.task.findMany({
                where: {
                    dueDate: { gte: now, lte: in24h },
                    deletedAt: null,
                    status: { notIn: ['DONE', 'CANCELLED'] },
                    // Reminded already for this due date; the marker is cleared
                    // whenever the due date changes.
                    dueSoonNotifiedAt: null,
                },
                include: {
                    project: { select: { key: true } },
                },
            });

            this.logger.log(
                `Found ${tasks.length} task(s) due within 24 hours`,
            );

            let notifiedCount = 0;
            let remindedCount = 0;

            for (const task of tasks) {
                // Claim the reminder before sending anything: with several app
                // replicas (or a retried job) only one caller may notify, and
                // the 24h window would otherwise fire on every 6h run.
                await this.prisma.$transaction(async (tx) => {
                    const { count } = await tx.task.updateMany({
                        where: {
                            id: task.id,
                            dueDate: task.dueDate,
                            assignedToId: task.assignedToId,
                            dueSoonNotifiedAt: null,
                            deletedAt: null,
                            status: { notIn: ['DONE', 'CANCELLED'] },
                        },
                        data: { dueSoonNotifiedAt: now },
                    });
                    if (count === 0) return;
                    const recipients =
                        await this.notificationsService.taskRecipients(
                            task.id,
                            tx,
                        );
                    const eventKey = `task:${task.id}:due-soon:${toIsoString(task.dueDate!)}`;
                    await this.notificationsService.publish(
                        {
                            eventKey,
                            type: 'TASK_DUE_SOON',
                            title: `Task ${task.project.key}-${task.number} is due soon`,
                            body: `"${task.title}" is due ${toIsoString(task.dueDate!)}`,
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
                            EmailTemplate.TASK_DUE_SOON,
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
                                accessScope: 'PROJECT',
                                userId: assignee.id,
                                organizationId: task.organizationId,
                                projectId: task.projectId,
                                minimumRole: 'MEMBER',
                            },
                        );
                    }
                    remindedCount += 1;
                    notifiedCount += recipients.length;
                });
            }

            const duration = Date.now() - jobStart;
            this.logger.log(
                `Task due-soon check completed in ${duration}ms — ` +
                    `tasks: ${tasks.length}, reminded: ${remindedCount}, ` +
                    `notifications: ${notifiedCount}`,
            );
        } catch (error) {
            const duration = Date.now() - jobStart;
            this.logger.error(
                `Task due-soon check failed after ${duration}ms`,
                error instanceof Error ? error.stack : String(error),
            );
        }
    }
}
