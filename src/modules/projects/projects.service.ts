import {
    Injectable,
    NotFoundException,
    ConflictException,
    BadRequestException,
    ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { CreateProjectDto, UpdateProjectDto } from './dto';
import { ProjectEntity } from './entities';
import { NotificationsService } from '../notifications/notifications.service';
import { randomUUID } from 'node:crypto';
import type { NotificationDb } from '../notifications/notification-event';
import { ProjectAccessService } from '../../common/authorization/project-access.service';
import type { AccessPrincipal } from '../../common/authorization/access.types';
import { lockOrganizationMembers } from '../../common/authorization/access-locks';
import { SettingsService } from '../settings';

@Injectable()
export class ProjectsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly notificationsService: NotificationsService,
        private readonly access: ProjectAccessService,
        private readonly settings: SettingsService,
    ) {}

    async create(orgId: string, userId: string, dto: CreateProjectDto) {
        // key 会出现在任务编号（PROJ-42）里，平台自留名（API / SYS / ADMIN…）
        // 一律不可用；比较不区分大小写，所以清单里写小写即可。
        await this.settings.assertSlugAllowed(dto.key, 'Project key');

        return this.prisma.$transaction(async (tx) => {
            await lockOrganizationMembers(tx, orgId, [userId]);
            const access = await this.access.organization(
                { type: 'USER', userId },
                orgId,
                tx,
            );
            if (!access.canManageOrganization)
                throw new ForbiddenException(
                    'Organization administration required',
                );
            // Enforce unique key per organization
            const existing = await tx.project.findUnique({
                where: {
                    organizationId_key: {
                        organizationId: orgId,
                        key: dto.key,
                    },
                },
            });

            if (existing) {
                throw new ConflictException(
                    `Project key "${dto.key}" is already taken in this organization`,
                );
            }

            const project = await tx.project.create({
                data: {
                    name: dto.name,
                    description: dto.description,
                    key: dto.key,
                    organizationId: orgId,
                    createdById: userId,
                },
            });

            return new ProjectEntity(project);
        });
    }

    async findAll(orgId: string, principal: AccessPrincipal) {
        const where = await this.access.projectFilter(principal, orgId);
        const projects = await this.prisma.project.findMany({
            where,
            orderBy: { createdAt: 'desc' },
        });

        return projects.map((p) => new ProjectEntity(p));
    }

    async findOne(
        orgId: string,
        projectId: string,
        principal: AccessPrincipal,
    ) {
        await this.access.project(principal, projectId, 'project.read', orgId);
        const project = await this.ensureProjectExists(orgId, projectId);
        return new ProjectEntity(project);
    }

    async update(
        orgId: string,
        projectId: string,
        actorId: string,
        dto: UpdateProjectDto,
    ) {
        return this.access.withProjectWrite(
            { type: 'USER', userId: actorId },
            orgId,
            projectId,
            'project.manage',
            async (tx) => {
                const project = await tx.project.update({
                    where: {
                        id: projectId,
                        organizationId: orgId,
                        deletedAt: null,
                    },
                    data: dto,
                });

                return new ProjectEntity(project);
            },
            'UPDATE',
        );
    }

    async archive(orgId: string, projectId: string, actorId: string) {
        const updated = await this.access.withProjectWrite(
            { type: 'USER', userId: actorId },
            orgId,
            projectId,
            'project.archive',
            async (tx) => {
                const project = await this.ensureProjectExists(
                    orgId,
                    projectId,
                    tx,
                );
                if (project.status === 'ARCHIVED') {
                    throw new BadRequestException(
                        'Project is already archived',
                    );
                }
                const updated = await tx.project.update({
                    where: { id: projectId },
                    data: { status: 'ARCHIVED' },
                });
                await this.notificationsService.publish(
                    {
                        eventKey: `project:${projectId}:archived:${randomUUID()}`,
                        type: 'PROJECT_ARCHIVED',
                        title: `Project "${updated.name}" has been archived`,
                        body: 'The project is now read-only. Restore it to make changes again.',
                        organizationId: orgId,
                        actorId,
                        resourceType: 'Project',
                        resourceId: projectId,
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

        return new ProjectEntity(updated);
    }

    async softDelete(orgId: string, projectId: string, actorId: string) {
        const updated = await this.access.withProjectWrite(
            { type: 'USER', userId: actorId },
            orgId,
            projectId,
            'project.delete',
            async (tx) => {
                const recipients =
                    await this.notificationsService.projectRecipients(
                        projectId,
                        tx,
                    );
                const updated = await tx.project.update({
                    where: { id: projectId },
                    data: { deletedAt: new Date() },
                });
                await this.notificationsService.publish(
                    {
                        eventKey: `project:${projectId}:deleted:${randomUUID()}`,
                        type: 'PROJECT_DELETED',
                        title: `Project "${updated.name}" was deleted`,
                        organizationId: orgId,
                        actorId,
                        resourceType: 'Project',
                        resourceId: projectId,
                        recipients,
                    },
                    tx,
                );
                return updated;
            },
            'UPDATE',
        );

        return new ProjectEntity(updated);
    }

    async restore(orgId: string, projectId: string, actorId: string) {
        const updated = await this.access.withProjectWrite(
            { type: 'USER', userId: actorId },
            orgId,
            projectId,
            'project.restore',
            async (tx) => {
                const project = await tx.project.findFirst({
                    where: { id: projectId, organizationId: orgId },
                });
                if (!project) throw new NotFoundException('Project not found');
                if (!project.deletedAt) {
                    throw new BadRequestException('Project is not deleted');
                }
                const updated = await tx.project.update({
                    where: { id: projectId },
                    data: { deletedAt: null, status: 'ACTIVE' },
                });
                await this.notificationsService.publish(
                    {
                        eventKey: `project:${projectId}:restored:${randomUUID()}`,
                        type: 'PROJECT_RESTORED',
                        title: `Project "${updated.name}" was restored`,
                        organizationId: orgId,
                        actorId,
                        resourceType: 'Project',
                        resourceId: projectId,
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

        return new ProjectEntity(updated);
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private async ensureProjectExists(
        orgId: string,
        projectId: string,
        db: NotificationDb = this.prisma,
    ) {
        const project = await db.project.findFirst({
            where: { id: projectId, organizationId: orgId, deletedAt: null },
        });

        if (!project) {
            throw new NotFoundException('Project not found');
        }

        return project;
    }
}
