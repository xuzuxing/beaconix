import {
    Injectable,
    NotFoundException,
    BadRequestException,
    ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import {
    CreateTaskDto,
    UpdateTaskDto,
    AssignTaskDto,
    MoveTaskToSprintDto,
    AddDependencyDto,
    QueryTasksDto,
} from './dto';
import {
    TaskEntity,
    TaskDependencyEntity,
    TaskActivityEntity,
} from './entities';
import { NotificationsService } from '../notifications/notifications.service';
import type {
    NotificationDb,
    NotificationEvent,
} from '../notifications/notification-event';
import { randomUUID } from 'node:crypto';
import { ProjectAccessService } from '../../common/authorization/project-access.service';
import type { AccessPrincipal } from '../../common/authorization/access.types';

// Shared select for user relations
const userSelect = {
    id: true,
    name: true,
    avatarUrl: true,
} as const;

/**
 * A task reminder cycle restarts only when the due date actually moves, so
 * editing other fields keeps the "already reminded" markers intact.
 */
export function dueDateChanged(
    previous: Date | null | undefined,
    next: Date | null,
): boolean {
    return (next?.getTime() ?? null) !== (previous?.getTime() ?? null);
}

// Human-readable labels for the fields tracked by buildActivityRecords
const TRACKED_FIELD_LABELS: Record<string, string> = {
    title: 'title',
    description: 'description',
    priority: 'priority',
    status: 'status',
    storyPoints: 'story points',
    dueDate: 'due date',
    parentTaskId: 'parent task',
};

@Injectable()
export class TasksService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly notificationsService: NotificationsService,
        private readonly access: ProjectAccessService,
    ) {}

    // ── CRUD ────────────────────────────────────────────────────────────

    async create(projectId: string, userId: string, dto: CreateTaskDto) {
        const task = await this.access.withProject(
            { type: 'USER', userId },
            projectId,
            'task.write',
            async (tx, project) => {
                if (dto.sprintId) {
                    await this.ensureSprintBelongsToProject(
                        dto.sprintId,
                        projectId,
                        tx,
                    );
                }
                if (dto.parentTaskId) {
                    await this.ensureTaskBelongsToProject(
                        dto.parentTaskId,
                        projectId,
                        tx,
                    );
                }
                if (dto.assignedToId) {
                    await this.ensureAssignee(
                        dto.assignedToId,
                        project.organizationId,
                        projectId,
                        tx,
                    );
                }
                // Auto-increment task number within the project (inside tx to reduce race window)
                const lastTask = await tx.task.findFirst({
                    where: { projectId },
                    orderBy: { number: 'desc' },
                    select: { number: true },
                });
                const nextNumber = (lastTask?.number ?? 0) + 1;

                const created = await tx.task.create({
                    data: {
                        number: nextNumber,
                        title: dto.title,
                        description: dto.description,
                        priority: (dto.priority as any) ?? 'MEDIUM',
                        storyPoints: dto.storyPoints,
                        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
                        organizationId: project.organizationId,
                        projectId,
                        sprintId: dto.sprintId ?? null,
                        parentTaskId: dto.parentTaskId ?? null,
                        assignedToId: dto.assignedToId ?? null,
                        createdById: userId,
                    },
                    include: {
                        createdBy: { select: userSelect },
                        assignedTo: { select: userSelect },
                    },
                });

                // Auto-watch creator
                await tx.taskWatcher.create({
                    data: { taskId: created.id, userId },
                });

                // Auto-watch assignee if different from creator
                if (dto.assignedToId && dto.assignedToId !== userId) {
                    await tx.taskWatcher.create({
                        data: { taskId: created.id, userId: dto.assignedToId },
                    });
                }

                // Log creation activity
                await tx.taskActivity.create({
                    data: {
                        taskId: created.id,
                        actorId: userId,
                        action: 'created task',
                        field: null,
                        oldValue: null,
                        newValue: null,
                    },
                });

                if (created.assignedToId) {
                    await this.publishTaskEvent(created, userId, tx, {
                        eventKey: `task:${created.id}:created`,
                        type: 'TASK_ASSIGNED',
                        title: `Task #${created.number} was assigned`,
                        recipients: [
                            {
                                userId: created.assignedToId,
                                title: `You were assigned to task #${created.number}`,
                                email: true,
                            },
                        ],
                    });
                }

                return created;
            },
            'NO KEY UPDATE',
            dto.assignedToId ? [dto.assignedToId] : [],
        );

        return new TaskEntity(task);
    }

    async findAll(
        projectId: string,
        query: QueryTasksDto,
        principal: AccessPrincipal,
    ) {
        const access = await this.access.project(principal, projectId);
        const page = query.page ?? 1;
        const limit = query.limit ?? 20;
        const skip = (page - 1) * limit;

        const where: any = {
            projectId,
            organizationId: access.organizationId,
            deletedAt: null,
        };

        if (query.status) where.status = query.status;
        if (query.priority) where.priority = query.priority;
        if (query.assignedToId) where.assignedToId = query.assignedToId;
        if (query.sprintId) where.sprintId = query.sprintId;
        if (query.parentTaskId) where.parentTaskId = query.parentTaskId;

        const [tasks, total] = await Promise.all([
            this.prisma.task.findMany({
                where,
                include: {
                    createdBy: { select: userSelect },
                    assignedTo: { select: userSelect },
                    _count: {
                        select: {
                            subTasks: {
                                where: {
                                    projectId,
                                    organizationId: access.organizationId,
                                    deletedAt: null,
                                },
                            },
                            comments: true,
                            attachments: true,
                            watchers: true,
                        },
                    },
                },
                orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
                skip,
                take: limit,
            }),
            this.prisma.task.count({ where }),
        ]);

        return {
            data: tasks.map((t) => new TaskEntity(t)),
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    async findBacklog(projectId: string, principal: AccessPrincipal) {
        const access = await this.access.project(principal, projectId);
        const tasks = await this.prisma.task.findMany({
            where: {
                projectId,
                organizationId: access.organizationId,
                sprintId: null,
                deletedAt: null,
            },
            include: {
                createdBy: { select: userSelect },
                assignedTo: { select: userSelect },
                _count: {
                    select: {
                        subTasks: {
                            where: {
                                projectId,
                                organizationId: access.organizationId,
                                deletedAt: null,
                            },
                        },
                        comments: true,
                        attachments: true,
                        watchers: true,
                    },
                },
            },
            orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        });

        return tasks.map((t) => new TaskEntity(t));
    }

    async findOne(
        projectId: string,
        taskId: string,
        principal: AccessPrincipal,
    ) {
        const access = await this.access.project(principal, projectId);
        const task = await this.prisma.task.findFirst({
            where: {
                id: taskId,
                projectId,
                organizationId: access.organizationId,
                deletedAt: null,
            },
            include: {
                createdBy: { select: userSelect },
                assignedTo: { select: userSelect },
                subTasks: {
                    where: {
                        projectId,
                        organizationId: access.organizationId,
                        deletedAt: null,
                    },
                    select: {
                        id: true,
                        number: true,
                        title: true,
                        status: true,
                        priority: true,
                        assignedToId: true,
                    },
                },
                dependencies: {
                    where: {
                        dependencyTask: {
                            projectId,
                            organizationId: access.organizationId,
                            deletedAt: null,
                        },
                    },
                    include: {
                        dependencyTask: {
                            select: {
                                id: true,
                                number: true,
                                title: true,
                                status: true,
                            },
                        },
                    },
                },
                dependents: {
                    where: {
                        dependentTask: {
                            projectId,
                            organizationId: access.organizationId,
                            deletedAt: null,
                        },
                    },
                    include: {
                        dependentTask: {
                            select: {
                                id: true,
                                number: true,
                                title: true,
                                status: true,
                            },
                        },
                    },
                },
                _count: {
                    select: {
                        subTasks: {
                            where: {
                                projectId,
                                organizationId: access.organizationId,
                                deletedAt: null,
                            },
                        },
                        comments: true,
                        attachments: true,
                        watchers: true,
                    },
                },
            },
        });

        if (!task) throw new NotFoundException('Task not found');

        return new TaskEntity(task);
    }

    async update(
        projectId: string,
        taskId: string,
        userId: string,
        dto: UpdateTaskDto,
    ) {
        const task = await this.access.withProject(
            { type: 'USER', userId },
            projectId,
            'task.write',
            async (tx) => {
                if (dto.parentTaskId !== undefined) {
                    if (dto.parentTaskId === taskId) {
                        throw new BadRequestException(
                            'A task cannot be its own parent',
                        );
                    }
                    if (dto.parentTaskId) {
                        await this.ensureTaskBelongsToProject(
                            dto.parentTaskId,
                            projectId,
                            tx,
                        );
                    }
                }

                const existing = await this.lockTask(projectId, taskId, tx);
                // Compute the transition from the locked, current task snapshot.
                const data: any = { ...dto };
                if (dto.dueDate !== undefined) {
                    const nextDueDate = dto.dueDate
                        ? new Date(dto.dueDate)
                        : null;
                    data.dueDate = nextDueDate;
                    if (dueDateChanged(existing.dueDate, nextDueDate)) {
                        data.dueSoonNotifiedAt = null;
                        data.overdueNotifiedAt = null;
                    }
                }
                if (dto.status === 'DONE' && existing.status !== 'DONE') {
                    data.completedAt = new Date();
                } else if (
                    dto.status &&
                    dto.status !== 'DONE' &&
                    existing.completedAt
                ) {
                    data.completedAt = null;
                }
                const updated = await tx.task.update({
                    where: { id: taskId },
                    data,
                    include: {
                        createdBy: { select: userSelect },
                        assignedTo: { select: userSelect },
                    },
                });

                // Log activity for each changed field
                const activities = this.buildActivityRecords(
                    taskId,
                    userId,
                    existing,
                    dto,
                );
                if (activities.length > 0) {
                    await tx.taskActivity.createMany({ data: activities });
                }

                const statusChanged =
                    !!dto.status && dto.status !== existing.status;
                const meaningfulFields = activities
                    .map((a) => a.field)
                    .filter((field) => ['priority', 'dueDate'].includes(field));
                const transitionKey = `task:${taskId}:updated:${randomUUID()}`;
                if (statusChanged || meaningfulFields.length > 0) {
                    await this.publishTaskEvent(updated, userId, tx, {
                        eventKey: transitionKey,
                        type: statusChanged
                            ? 'TASK_STATUS_CHANGED'
                            : 'TASK_UPDATED',
                        title: statusChanged
                            ? `Task #${existing.number} status changed to ${dto.status}`
                            : `Task #${existing.number} was updated`,
                        body: statusChanged
                            ? `"${updated.title}" was moved to ${dto.status}`
                            : `"${updated.title}" - changed: ${meaningfulFields.map((field) => TRACKED_FIELD_LABELS[field]).join(', ')}`,
                    });
                }

                if (statusChanged && dto.status === 'DONE') {
                    const dependents = await tx.task.findMany({
                        where: {
                            projectId,
                            deletedAt: null,
                            status: { notIn: ['DONE', 'CANCELLED'] },
                            dependencies: {
                                some: { dependencyTaskId: taskId },
                                none: {
                                    dependencyTask: {
                                        deletedAt: null,
                                        status: { not: 'DONE' },
                                    },
                                },
                            },
                        },
                    });
                    for (const dependent of dependents) {
                        await this.publishTaskEvent(dependent, userId, tx, {
                            eventKey: `${transitionKey}:unblocked:${dependent.id}`,
                            type: 'TASK_UNBLOCKED',
                            title: `Task #${dependent.number} is no longer blocked`,
                            meta: { dependencyTaskId: taskId },
                        });
                    }
                }

                return updated;
            },
            dto.status === 'DONE' ? 'NO KEY UPDATE' : 'SHARE',
        );

        return new TaskEntity(task);
    }

    async softDelete(projectId: string, taskId: string, userId: string) {
        const task = await this.access.withProject(
            { type: 'USER', userId },
            projectId,
            'task.write',
            async (tx) => {
                await this.lockTask(projectId, taskId, tx);
                const recipients =
                    await this.notificationsService.taskRecipients(taskId, tx);
                const deleted = await tx.task.update({
                    where: { id: taskId },
                    data: { deletedAt: new Date() },
                });

                await tx.taskActivity.create({
                    data: {
                        taskId,
                        actorId: userId,
                        action: 'soft-deleted task',
                    },
                });

                await this.publishTaskEvent(
                    deleted,
                    userId,
                    tx,
                    {
                        eventKey: `task:${taskId}:deleted:${randomUUID()}`,
                        type: 'TASK_DELETED',
                        title: `Task #${deleted.number} was deleted`,
                        recipients,
                    },
                    false,
                );

                return deleted;
            },
        );

        return new TaskEntity(task);
    }

    async restore(projectId: string, taskId: string, userId: string) {
        const restored = await this.access.withProject(
            { type: 'USER', userId },
            projectId,
            'task.restore',
            async (tx) => {
                const task = await this.lockTask(projectId, taskId, tx, true);
                if (!task.deletedAt) {
                    throw new BadRequestException('Task is not deleted');
                }
                const updated = await tx.task.update({
                    where: { id: taskId },
                    data: { deletedAt: null },
                });

                await tx.taskActivity.create({
                    data: {
                        taskId,
                        actorId: userId,
                        action: 'restored task',
                    },
                });

                await this.publishTaskEvent(updated, userId, tx, {
                    eventKey: `task:${taskId}:restored:${randomUUID()}`,
                    type: 'TASK_RESTORED',
                    title: `Task #${updated.number} was restored`,
                });

                return updated;
            },
        );

        return new TaskEntity(restored);
    }

    // ── ASSIGN ──────────────────────────────────────────────────────────

    async assign(
        projectId: string,
        taskId: string,
        userId: string,
        dto: AssignTaskDto,
    ) {
        const task = await this.access.withProject(
            { type: 'USER', userId },
            projectId,
            'task.write',
            async (tx, project) => {
                if (dto.assignedToId) {
                    await this.ensureAssignee(
                        dto.assignedToId,
                        project.organizationId,
                        projectId,
                        tx,
                    );
                }
                const existing = await this.lockTask(projectId, taskId, tx);
                const updated = await tx.task.update({
                    where: { id: taskId },
                    data: { assignedToId: dto.assignedToId },
                    include: {
                        createdBy: { select: userSelect },
                        assignedTo: { select: userSelect },
                    },
                });

                // Auto-watch new assignee
                if (dto.assignedToId) {
                    await tx.taskWatcher.upsert({
                        where: {
                            taskId_userId: { taskId, userId: dto.assignedToId },
                        },
                        create: { taskId, userId: dto.assignedToId },
                        update: {},
                    });
                }

                // Log activity
                await tx.taskActivity.create({
                    data: {
                        taskId,
                        actorId: userId,
                        action: dto.assignedToId
                            ? 'assigned task'
                            : 'unassigned task',
                        field: 'assignedToId',
                        oldValue: existing.assignedToId,
                        newValue: dto.assignedToId,
                    },
                });

                if (
                    dto.assignedToId !== undefined &&
                    existing.assignedToId !== dto.assignedToId
                ) {
                    await this.publishTaskEvent(updated, userId, tx, {
                        eventKey: `task:${taskId}:assignment:${randomUUID()}`,
                        type: dto.assignedToId
                            ? 'TASK_ASSIGNED'
                            : 'TASK_UNASSIGNED',
                        title: `Task #${existing.number} assignment changed`,
                        recipients: [
                            ...(dto.assignedToId
                                ? [
                                      {
                                          userId: dto.assignedToId,
                                          type: 'TASK_ASSIGNED' as const,
                                          title: `You were assigned to task #${existing.number}`,
                                          email: true,
                                      },
                                  ]
                                : []),
                            ...(existing.assignedToId
                                ? [
                                      {
                                          userId: existing.assignedToId,
                                          type: 'TASK_UNASSIGNED' as const,
                                          title: `You are no longer assigned to task #${existing.number}`,
                                      },
                                  ]
                                : []),
                        ],
                        meta: {
                            previousAssigneeId: existing.assignedToId,
                            assignedToId: dto.assignedToId,
                        },
                    });
                }

                return updated;
            },
            'SHARE',
            dto.assignedToId ? [dto.assignedToId] : [],
        );

        return new TaskEntity(task);
    }

    // ── SPRINT MOVE ─────────────────────────────────────────────────────

    async moveToSprint(
        projectId: string,
        taskId: string,
        userId: string,
        dto: MoveTaskToSprintDto,
    ) {
        const task = await this.access.withProject(
            { type: 'USER', userId },
            projectId,
            'task.write',
            async (tx) => {
                if (dto.sprintId) {
                    await this.ensureSprintBelongsToProject(
                        dto.sprintId,
                        projectId,
                        tx,
                    );
                }
                const existing = await this.lockTask(projectId, taskId, tx);
                const updated = await tx.task.update({
                    where: { id: taskId },
                    data: { sprintId: dto.sprintId },
                    include: {
                        createdBy: { select: userSelect },
                        assignedTo: { select: userSelect },
                    },
                });

                await tx.taskActivity.create({
                    data: {
                        taskId,
                        actorId: userId,
                        action: dto.sprintId
                            ? 'moved task to sprint'
                            : 'moved task to backlog',
                        field: 'sprintId',
                        oldValue: existing.sprintId,
                        newValue: dto.sprintId,
                    },
                });

                if (
                    dto.sprintId !== undefined &&
                    existing.sprintId !== dto.sprintId
                ) {
                    await this.publishTaskEvent(updated, userId, tx, {
                        eventKey: `task:${taskId}:sprint:${randomUUID()}`,
                        type: 'TASK_SPRINT_CHANGED',
                        title: dto.sprintId
                            ? `Task #${existing.number} moved to a sprint`
                            : `Task #${existing.number} moved to backlog`,
                        meta: {
                            previousSprintId: existing.sprintId,
                            sprintId: dto.sprintId,
                        },
                    });
                }

                return updated;
            },
        );

        return new TaskEntity(task);
    }

    // ── WATCHERS ────────────────────────────────────────────────────────

    async watch(projectId: string, taskId: string, userId: string) {
        await this.access.withProject(
            { type: 'USER', userId },
            projectId,
            'task.subscribe',
            async (tx) => {
                await this.ensureTaskExists(projectId, taskId, tx);

                const existing = await tx.taskWatcher.findUnique({
                    where: { taskId_userId: { taskId, userId } },
                });

                if (existing) {
                    throw new ConflictException(
                        'You are already watching this task',
                    );
                }

                await tx.taskWatcher.create({
                    data: { taskId, userId },
                });
            },
        );
    }

    async unwatch(projectId: string, taskId: string, userId: string) {
        await this.access.withProject(
            { type: 'USER', userId },
            projectId,
            'task.subscribe',
            async (tx) => {
                await this.ensureTaskExists(projectId, taskId, tx);

                const existing = await tx.taskWatcher.findUnique({
                    where: { taskId_userId: { taskId, userId } },
                });

                if (!existing) {
                    throw new NotFoundException(
                        'You are not watching this task',
                    );
                }

                await tx.taskWatcher.delete({
                    where: { id: existing.id },
                });
            },
        );
    }

    // ── DEPENDENCIES ────────────────────────────────────────────────────

    async addDependency(
        projectId: string,
        taskId: string,
        userId: string,
        dto: AddDependencyDto,
    ) {
        const dependency = await this.access.withProject(
            { type: 'USER', userId },
            projectId,
            'task.write',
            async (tx) => {
                const task = await this.lockTask(projectId, taskId, tx);
                await this.ensureTaskBelongsToProject(
                    dto.dependencyTaskId,
                    projectId,
                    tx,
                );

                if (dto.dependencyTaskId === taskId) {
                    throw new BadRequestException(
                        'A task cannot depend on itself',
                    );
                }

                // Check for existing dependency
                const existing = await tx.taskDependency.findUnique({
                    where: {
                        dependentTaskId_dependencyTaskId: {
                            dependentTaskId: taskId,
                            dependencyTaskId: dto.dependencyTaskId,
                        },
                    },
                });

                if (existing) {
                    throw new ConflictException(
                        'This dependency already exists',
                    );
                }

                // Circular dependency check via BFS
                await this.checkCircularDependency(
                    taskId,
                    dto.dependencyTaskId,
                    tx,
                );

                const dep = await tx.taskDependency.create({
                    data: {
                        dependentTaskId: taskId,
                        dependencyTaskId: dto.dependencyTaskId,
                    },
                    include: {
                        dependencyTask: {
                            select: {
                                id: true,
                                number: true,
                                title: true,
                                status: true,
                            },
                        },
                    },
                });

                await tx.taskActivity.create({
                    data: {
                        taskId,
                        actorId: userId,
                        action: 'added dependency',
                        field: 'dependencies',
                        newValue: dto.dependencyTaskId,
                    },
                });

                await this.publishTaskEvent(task, userId, tx, {
                    eventKey: `task:${taskId}:dependency:${dep.id}:added`,
                    type: 'TASK_DEPENDENCY_CHANGED',
                    title: `A dependency was added to task #${task.number}`,
                    meta: {
                        dependencyTaskId: dto.dependencyTaskId,
                        action: 'added',
                    },
                });

                return dep;
            },
            'NO KEY UPDATE',
        );

        return new TaskDependencyEntity(dependency);
    }

    async removeDependency(
        projectId: string,
        taskId: string,
        depId: string,
        userId: string,
    ) {
        await this.access.withProject(
            { type: 'USER', userId },
            projectId,
            'task.write',
            async (tx) => {
                const task = await this.lockTask(projectId, taskId, tx);

                const dependency = await tx.taskDependency.findFirst({
                    where: { id: depId, dependentTaskId: taskId },
                });

                if (!dependency) {
                    throw new NotFoundException('Dependency not found');
                }

                await tx.taskDependency.delete({ where: { id: depId } });

                await tx.taskActivity.create({
                    data: {
                        taskId,
                        actorId: userId,
                        action: 'removed dependency',
                        field: 'dependencies',
                        oldValue: dependency.dependencyTaskId,
                    },
                });

                await this.publishTaskEvent(task, userId, tx, {
                    eventKey: `task:${taskId}:dependency:${depId}:removed`,
                    type: 'TASK_DEPENDENCY_CHANGED',
                    title: `A dependency was removed from task #${task.number}`,
                    meta: {
                        dependencyTaskId: dependency.dependencyTaskId,
                        action: 'removed',
                    },
                });
            },
        );
    }

    // ── ACTIVITIES ──────────────────────────────────────────────────────

    async getActivities(
        projectId: string,
        taskId: string,
        principal: AccessPrincipal,
    ) {
        await this.access.project(principal, projectId);
        await this.ensureTaskExists(projectId, taskId);

        const activities = await this.prisma.taskActivity.findMany({
            where: { taskId },
            include: {
                actor: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: 'desc' },
        });

        return activities.map((a) => new TaskActivityEntity(a));
    }

    // ── PRIVATE HELPERS ─────────────────────────────────────────────────

    private async lockTask(
        projectId: string,
        taskId: string,
        tx: NotificationDb,
        includeDeleted = false,
    ) {
        // Serialize transitions so previous assignee/status and no-op detection
        // cannot race another mutation of this task.
        await tx.$queryRaw`
            SELECT "id" FROM "tasks"
            WHERE "id" = ${taskId} AND "projectId" = ${projectId}
            FOR UPDATE
        `;
        const task = await tx.task.findFirst({
            where: {
                id: taskId,
                projectId,
                ...(includeDeleted ? {} : { deletedAt: null }),
            },
        });
        if (!task) throw new NotFoundException('Task not found');
        return task;
    }

    private async publishTaskEvent(
        task: { id: string; organizationId: string; number: number },
        actorId: string,
        tx: NotificationDb,
        event: Omit<NotificationEvent, 'recipients'> & {
            recipients?: NotificationEvent['recipients'];
        },
        resolveRecipients = true,
    ) {
        const candidates = [
            ...(event.recipients ?? []),
            ...(resolveRecipients
                ? await this.notificationsService.taskRecipients(task.id, tx)
                : []),
        ];
        const recipients = new Map<
            string,
            NotificationEvent['recipients'][number]
        >();
        for (const recipient of candidates) {
            const id =
                typeof recipient === 'string' ? recipient : recipient.userId;
            if (id !== actorId && !recipients.has(id))
                recipients.set(id, recipient);
        }
        await this.notificationsService.publish(
            {
                ...event,
                organizationId: task.organizationId,
                actorId,
                resourceType: 'Task',
                resourceId: task.id,
                recipients: [...recipients.values()],
            },
            tx,
        );
    }

    private async ensureTaskExists(
        projectId: string,
        taskId: string,
        db: NotificationDb = this.prisma,
    ) {
        const task = await db.task.findFirst({
            where: { id: taskId, projectId, deletedAt: null },
        });

        if (!task) throw new NotFoundException('Task not found');
        return task;
    }

    private async ensureSprintBelongsToProject(
        sprintId: string,
        projectId: string,
        db: NotificationDb = this.prisma,
    ) {
        const sprint = await db.sprint.findFirst({
            where: { id: sprintId, projectId },
        });

        if (!sprint) {
            throw new BadRequestException(
                'Sprint does not belong to this project',
            );
        }

        return sprint;
    }

    private async ensureTaskBelongsToProject(
        taskId: string,
        projectId: string,
        db: NotificationDb = this.prisma,
    ) {
        const task = await db.task.findFirst({
            where: { id: taskId, projectId, deletedAt: null },
        });

        if (!task) {
            throw new BadRequestException(
                'Referenced task does not belong to this project',
            );
        }

        return task;
    }

    private async ensureAssignee(
        userId: string,
        organizationId: string,
        projectId: string,
        tx: NotificationDb,
    ) {
        const membership = await tx.membership.findFirst({
            where: {
                ...this.access.projectMemberFilter(
                    organizationId,
                    projectId,
                    true,
                ),
                userId,
            },
        });

        if (!membership) {
            throw new BadRequestException(
                'Assignee must be a current writable project member',
            );
        }
    }

    /**
     * BFS circular dependency check.
     * If we're adding: dependentTaskId (taskId) depends on dependencyTaskId,
     * check that dependencyTaskId doesn't already transitively depend on taskId.
     */
    private async checkCircularDependency(
        dependentTaskId: string,
        dependencyTaskId: string,
        db: NotificationDb = this.prisma,
    ) {
        const maxDepth = 50;
        const visited = new Set<string>();
        const queue = [dependencyTaskId];

        while (queue.length > 0) {
            if (visited.size >= maxDepth) {
                throw new BadRequestException(
                    'Dependency chain is too deep to validate',
                );
            }

            const current = queue.shift()!;
            if (current === dependentTaskId) {
                throw new BadRequestException(
                    'Adding this dependency would create a circular reference',
                );
            }

            if (visited.has(current)) continue;
            visited.add(current);

            // Find all tasks that `current` depends on
            const deps = await db.taskDependency.findMany({
                where: { dependentTaskId: current },
                select: { dependencyTaskId: true },
            });

            for (const dep of deps) {
                if (!visited.has(dep.dependencyTaskId)) {
                    queue.push(dep.dependencyTaskId);
                }
            }
        }
    }

    /**
     * Build activity records for changed fields during update.
     */
    private buildActivityRecords(
        taskId: string,
        actorId: string,
        existing: Record<string, any>,
        dto: UpdateTaskDto,
    ) {
        const activities: Array<{
            taskId: string;
            actorId: string;
            action: string;
            field: string;
            oldValue: string | null;
            newValue: string | null;
        }> = [];

        const trackedFields = Object.entries(TRACKED_FIELD_LABELS) as Array<
            [keyof UpdateTaskDto, string]
        >;

        for (const [key, label] of trackedFields) {
            if (dto[key] !== undefined) {
                const oldVal = existing[key];
                const newVal = dto[key];

                // Only log if actually changed
                const changed =
                    key === 'dueDate'
                        ? dueDateChanged(
                              oldVal,
                              newVal ? new Date(newVal) : null,
                          )
                        : String(oldVal ?? '') !== String(newVal ?? '');
                if (changed) {
                    activities.push({
                        taskId,
                        actorId,
                        action: `changed ${label} from "${oldVal ?? 'none'}" to "${newVal ?? 'none'}"`,
                        field: key,
                        oldValue: oldVal != null ? String(oldVal) : null,
                        newValue: newVal != null ? String(newVal) : null,
                    });
                }
            }
        }

        return activities;
    }
}
