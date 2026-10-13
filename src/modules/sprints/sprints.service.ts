import {
    Injectable,
    NotFoundException,
    BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { CreateSprintDto, UpdateSprintDto } from './dto';
import { SprintEntity } from './entities';
import { NotificationsService } from '../notifications/notifications.service';
import type { NotificationDb } from '../notifications/notification-event';
import { ProjectAccessService } from '../../common/authorization/project-access.service';
import type { AccessPrincipal } from '../../common/authorization/access.types';

@Injectable()
export class SprintsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly notificationsService: NotificationsService,
        private readonly access: ProjectAccessService,
    ) {}

    async create(projectId: string, dto: CreateSprintDto, actorId: string) {
        return this.access.withProject(
            { type: 'USER', userId: actorId },
            projectId,
            'sprint.manage',
            async (tx) => {
                // Auto-assign next order if not provided
                let order = dto.order;
                if (order === undefined) {
                    const lastSprint = await tx.sprint.findFirst({
                        where: { projectId },
                        orderBy: { order: 'desc' },
                        select: { order: true },
                    });
                    order = (lastSprint?.order ?? -1) + 1;
                }

                const sprint = await tx.sprint.create({
                    data: {
                        name: dto.name,
                        goal: dto.goal,
                        startDate: dto.startDate
                            ? new Date(dto.startDate)
                            : null,
                        endDate: dto.endDate ? new Date(dto.endDate) : null,
                        order,
                        projectId,
                    },
                });

                return new SprintEntity(sprint);
            },
            'UPDATE',
        );
    }

    async findAll(projectId: string, principal: AccessPrincipal) {
        await this.access.project(principal, projectId);
        const sprints = await this.prisma.sprint.findMany({
            where: { projectId },
            orderBy: { order: 'asc' },
        });

        return sprints.map((s) => new SprintEntity(s));
    }

    async findOne(
        projectId: string,
        sprintId: string,
        principal: AccessPrincipal,
    ) {
        await this.access.project(principal, projectId);
        const sprint = await this.ensureSprintExists(projectId, sprintId);
        return new SprintEntity(sprint);
    }

    async update(
        projectId: string,
        sprintId: string,
        dto: UpdateSprintDto,
        actorId: string,
    ) {
        return this.access.withProject(
            { type: 'USER', userId: actorId },
            projectId,
            'sprint.manage',
            async (tx) => {
                await this.ensureSprintExists(projectId, sprintId, tx);

                const sprint = await tx.sprint.update({
                    where: { id: sprintId, projectId },
                    data: {
                        name: dto.name,
                        goal: dto.goal,
                        startDate: dto.startDate
                            ? new Date(dto.startDate)
                            : undefined,
                        endDate: dto.endDate
                            ? new Date(dto.endDate)
                            : undefined,
                        order: dto.order,
                    },
                });

                return new SprintEntity(sprint);
            },
            'UPDATE',
        );
    }

    /**
     * Start a sprint: PLANNED → ACTIVE.
     * Only one sprint should be ACTIVE per project at a time.
     */
    async start(projectId: string, sprintId: string, actorId: string) {
        const updated = await this.access.withProject(
            { type: 'USER', userId: actorId },
            projectId,
            'sprint.manage',
            async (tx, project) => {
                const sprint = await tx.sprint.findFirst({
                    where: { id: sprintId, projectId },
                });
                if (!sprint) throw new NotFoundException('Sprint not found');

                if (sprint.status !== 'PLANNED') {
                    throw new BadRequestException(
                        `Cannot start sprint with status: ${sprint.status}. Only PLANNED sprints can be started.`,
                    );
                }

                const activeSprint = await tx.sprint.findFirst({
                    where: { projectId, status: 'ACTIVE' },
                });

                if (activeSprint) {
                    throw new BadRequestException(
                        `Project already has an active sprint: "${activeSprint.name}". Complete it before starting a new one.`,
                    );
                }

                const updated = await tx.sprint.update({
                    where: { id: sprintId },
                    data: {
                        status: 'ACTIVE',
                        startDate: sprint.startDate ?? new Date(),
                    },
                });
                await this.notificationsService.publish(
                    {
                        eventKey: `sprint:${sprintId}:started`,
                        type: 'SPRINT_STARTED',
                        title: `Sprint "${updated.name}" has started`,
                        organizationId: project.organizationId,
                        actorId,
                        resourceType: 'Sprint',
                        resourceId: sprintId,
                        meta: { projectId },
                        recipients:
                            await this.notificationsService.projectRecipients(
                                projectId,
                                tx,
                            ),
                    },
                    tx,
                );
                return updated;
            },
            'UPDATE',
        );

        return new SprintEntity(updated);
    }

    /**
     * Complete a sprint: ACTIVE → COMPLETED.
     * Tasks still in this sprint with status != DONE get their sprintId set to null (back to backlog).
     */
    async complete(projectId: string, sprintId: string, actorId: string) {
        const updatedSprint = await this.access.withProject(
            { type: 'USER', userId: actorId },
            projectId,
            'sprint.manage',
            async (tx, project) => {
                const sprint = await this.ensureSprintExists(
                    projectId,
                    sprintId,
                    tx,
                );
                if (sprint.status !== 'ACTIVE') {
                    throw new BadRequestException(
                        `Cannot complete sprint with status: ${sprint.status}. Only ACTIVE sprints can be completed.`,
                    );
                }
                const updated = await tx.sprint.update({
                    where: { id: sprintId },
                    data: {
                        status: 'COMPLETED',
                        endDate: sprint.endDate ?? new Date(),
                    },
                });
                await this.moveTasksToBacklog(
                    projectId,
                    sprintId,
                    project.organizationId,
                    actorId,
                    tx,
                    'completed',
                );
                await this.notificationsService.publish(
                    {
                        eventKey: `sprint:${sprintId}:completed`,
                        type: 'SPRINT_COMPLETED',
                        title: `Sprint "${sprint.name}" has been completed`,
                        organizationId: project.organizationId,
                        actorId,
                        resourceType: 'Sprint',
                        resourceId: sprintId,
                        meta: { projectId },
                        recipients:
                            await this.notificationsService.projectRecipients(
                                projectId,
                                tx,
                            ),
                    },
                    tx,
                );
                return updated;
            },
            'UPDATE',
        );

        return new SprintEntity(updatedSprint);
    }

    async remove(projectId: string, sprintId: string, actorId: string) {
        // Explicitly move tasks to backlog before deletion
        await this.access.withProject(
            { type: 'USER', userId: actorId },
            projectId,
            'sprint.manage',
            async (tx, project) => {
                const owner = await tx.project.findFirst({
                    where: {
                        id: projectId,
                        organizationId: project.organizationId,
                        deletedAt: null,
                    },
                    select: { createdById: true },
                });
                const sprint = await this.ensureSprintExists(
                    projectId,
                    sprintId,
                    tx,
                );
                if (sprint.status === 'ACTIVE') {
                    throw new BadRequestException(
                        'Cannot delete an active sprint. Complete it first.',
                    );
                }
                const impacted = await this.moveTasksToBacklog(
                    projectId,
                    sprintId,
                    project.organizationId,
                    actorId,
                    tx,
                    'deleted',
                );
                await tx.sprint.delete({
                    where: { id: sprintId },
                });
                await this.notificationsService.publish(
                    {
                        eventKey: `sprint:${sprintId}:deleted`,
                        type: 'SPRINT_DELETED',
                        title: `Sprint "${sprint.name}" was deleted`,
                        organizationId: project.organizationId,
                        actorId,
                        resourceType: 'Project',
                        resourceId: projectId,
                        meta: { sprintId },
                        recipients: [
                            ...new Set(
                                [
                                    ...impacted,
                                    owner?.createdById,
                                    ...(await this.notificationsService.organizationRecipients(
                                        project.organizationId,
                                        tx,
                                        ['OWNER', 'ADMIN'],
                                    )),
                                ].filter((id): id is string => id !== null),
                            ),
                        ],
                    },
                    tx,
                );
            },
            'UPDATE',
        );
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private async ensureSprintExists(
        projectId: string,
        sprintId: string,
        db: NotificationDb = this.prisma,
    ) {
        const sprint = await db.sprint.findFirst({
            where: { id: sprintId, projectId },
        });

        if (!sprint) {
            throw new NotFoundException('Sprint not found');
        }

        return sprint;
    }

    private async moveTasksToBacklog(
        projectId: string,
        sprintId: string,
        organizationId: string,
        actorId: string,
        tx: NotificationDb,
        reason: 'completed' | 'deleted',
    ) {
        const where = {
            projectId,
            sprintId,
            deletedAt: null,
            ...(reason === 'completed'
                ? { status: { not: 'DONE' as const } }
                : {}),
        };
        const tasks = await tx.task.updateManyAndReturn({
            where,
            data: { sprintId: null },
            select: { id: true, number: true },
        });
        const impacted = new Set<string>();
        for (const task of tasks) {
            const recipients = await this.notificationsService.taskRecipients(
                task.id,
                tx,
            );
            recipients.forEach((id) => impacted.add(id));
            await this.notificationsService.publish(
                {
                    eventKey: `sprint:${sprintId}:${reason}:task:${task.id}:backlog`,
                    type: 'TASK_SPRINT_CHANGED',
                    title: `Task #${task.number} moved to backlog`,
                    organizationId,
                    actorId,
                    resourceType: 'Task',
                    resourceId: task.id,
                    meta: {
                        previousSprintId: sprintId,
                        sprintId: null,
                        reason,
                    },
                    recipients,
                },
                tx,
            );
        }
        return [...impacted];
    }
}
