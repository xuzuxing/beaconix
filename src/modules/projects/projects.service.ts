import {
    Injectable,
    NotFoundException,
    ConflictException,
    BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { CreateProjectDto, UpdateProjectDto } from './dto';
import { ProjectEntity } from './entities';
import { NotificationsService } from '../notifications/notifications.service';
import { randomUUID } from 'node:crypto';
import type { NotificationDb } from '../notifications/notification-event';

@Injectable()
export class ProjectsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly notificationsService: NotificationsService,
    ) {}

    async create(orgId: string, userId: string, dto: CreateProjectDto) {
        // Enforce unique key per organization
        const existing = await this.prisma.project.findUnique({
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

        const project = await this.prisma.project.create({
            data: {
                name: dto.name,
                description: dto.description,
                key: dto.key,
                organizationId: orgId,
                createdById: userId,
            },
        });

        return new ProjectEntity(project);
    }

    async findAll(orgId: string) {
        const projects = await this.prisma.project.findMany({
            where: { organizationId: orgId, deletedAt: null },
            orderBy: { createdAt: 'desc' },
        });

        return projects.map((p) => new ProjectEntity(p));
    }

    async findOne(orgId: string, projectId: string) {
        const project = await this.ensureProjectExists(orgId, projectId);
        return new ProjectEntity(project);
    }

    async update(orgId: string, projectId: string, dto: UpdateProjectDto) {
        await this.ensureProjectExists(orgId, projectId);

        const project = await this.prisma.project.update({
            where: { id: projectId },
            data: dto,
        });

        return new ProjectEntity(project);
    }

    async archive(orgId: string, projectId: string, actorId: string) {
        const updated = await this.prisma.$transaction(async (tx) => {
            const project = await this.lockProject(orgId, projectId, tx);
            if (project.status === 'ARCHIVED') {
                throw new BadRequestException('Project is already archived');
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
        });

        return new ProjectEntity(updated);
    }

    async softDelete(orgId: string, projectId: string, actorId: string) {
        const updated = await this.prisma.$transaction(async (tx) => {
            await this.lockProject(orgId, projectId, tx);
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
        });

        return new ProjectEntity(updated);
    }

    async restore(orgId: string, projectId: string, actorId: string) {
        const updated = await this.prisma.$transaction(async (tx) => {
            const project = await this.lockProject(orgId, projectId, tx, true);
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
        });

        return new ProjectEntity(updated);
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private async lockProject(
        orgId: string,
        projectId: string,
        tx: NotificationDb,
        includeDeleted = false,
    ) {
        await tx.$queryRaw`
            SELECT "id" FROM "projects"
            WHERE "id" = ${projectId} AND "organizationId" = ${orgId}
            FOR UPDATE
        `;
        const project = await tx.project.findFirst({
            where: {
                id: projectId,
                organizationId: orgId,
                ...(includeDeleted ? {} : { deletedAt: null }),
            },
        });
        if (!project) throw new NotFoundException('Project not found');
        return project;
    }

    private async ensureProjectExists(orgId: string, projectId: string) {
        const project = await this.prisma.project.findFirst({
            where: { id: projectId, organizationId: orgId, deletedAt: null },
        });

        if (!project) {
            throw new NotFoundException('Project not found');
        }

        return project;
    }
}
