import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import type { AccessDb } from './access-locks';
import type { ProjectResourceSelector } from './access.types';

@Injectable()
export class ResourceContextResolver {
    constructor(private readonly prisma: PrismaService) {}

    async resolve(
        params: Record<string, string>,
        selector: ProjectResourceSelector,
        includeDeleted = false,
        db: AccessDb = this.prisma,
    ) {
        const id = params[selector.idParam];
        if (!id) throw new NotFoundException('Resource not found');
        let projectId: string | null = null;
        let taskId: string | null = null;
        let resourceOrganizationId: string | null = null;
        const active = includeDeleted ? {} : { deletedAt: null };
        switch (selector.resourceType) {
            case 'PROJECT':
                projectId = id;
                break;
            case 'TASK': {
                const task = await db.task.findFirst({
                    where: { id, ...active },
                    select: { id: true, projectId: true, organizationId: true },
                });
                projectId = task?.projectId ?? null;
                taskId = task?.id ?? null;
                resourceOrganizationId = task?.organizationId ?? null;
                break;
            }
            case 'SPRINT':
                projectId =
                    (
                        await db.sprint.findUnique({
                            where: { id },
                            select: { projectId: true },
                        })
                    )?.projectId ?? null;
                break;
            case 'MONITOR': {
                const monitor = await db.monitor.findFirst({
                    where: { id, ...active },
                    select: { projectId: true, organizationId: true },
                });
                projectId = monitor?.projectId ?? null;
                resourceOrganizationId = monitor?.organizationId ?? null;
                break;
            }
            case 'LABEL': {
                const label = await db.label.findUnique({
                    where: { id },
                    select: { projectId: true, organizationId: true },
                });
                projectId = label?.projectId ?? null;
                resourceOrganizationId = label?.organizationId ?? null;
                break;
            }
            case 'RULE_GROUP': {
                const rule = await db.ruleGroup.findFirst({
                    where: { id, ...active },
                    select: { projectId: true, organizationId: true },
                });
                projectId = rule?.projectId ?? null;
                resourceOrganizationId = rule?.organizationId ?? null;
                break;
            }
            case 'ALERT_EVENT': {
                const event = await db.alertEvent.findUnique({
                    where: { id },
                    select: { projectId: true, organizationId: true },
                });
                projectId = event?.projectId ?? null;
                resourceOrganizationId = event?.organizationId ?? null;
                break;
            }
            case 'COMMENT': {
                const comment = await db.comment.findFirst({
                    where: { id, ...active, task: { deletedAt: null } },
                    select: {
                        taskId: true,
                        task: {
                            select: { projectId: true, organizationId: true },
                        },
                    },
                });
                projectId = comment?.task.projectId ?? null;
                taskId = comment?.taskId ?? null;
                resourceOrganizationId = comment?.task.organizationId ?? null;
                break;
            }
            case 'ATTACHMENT': {
                const attachment = await db.attachment.findFirst({
                    where: { id, task: { deletedAt: null } },
                    select: {
                        taskId: true,
                        task: {
                            select: { projectId: true, organizationId: true },
                        },
                    },
                });
                projectId = attachment?.task?.projectId ?? null;
                taskId = attachment?.taskId ?? null;
                resourceOrganizationId =
                    attachment?.task?.organizationId ?? null;
                break;
            }
        }
        if (
            !projectId ||
            (selector.projectParam &&
                params[selector.projectParam] !== projectId) ||
            (selector.taskParam && params[selector.taskParam] !== taskId)
        )
            throw new NotFoundException('Resource not found');
        const project = await db.project.findFirst({
            where: {
                id: projectId,
                ...active,
                organization: { deletedAt: null },
            },
            select: { organizationId: true },
        });
        if (
            !project ||
            (resourceOrganizationId !== null &&
                resourceOrganizationId !== project.organizationId) ||
            (selector.organizationParam &&
                params[selector.organizationParam] !== project.organizationId)
        )
            throw new NotFoundException('Resource not found');
        return { organizationId: project.organizationId, projectId, taskId };
    }
}
