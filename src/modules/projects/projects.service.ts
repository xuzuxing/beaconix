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

    async archive(orgId: string, projectId: string) {
        const project = await this.ensureProjectExists(orgId, projectId);

        if (project.status === 'ARCHIVED') {
            throw new BadRequestException('Project is already archived');
        }

        const updated = await this.prisma.project.update({
            where: { id: projectId },
            data: { status: 'ARCHIVED' },
        });

        // Notify every org member about the archive (fire-and-forget)
        this.notifyOrgMembers(project.organizationId, {
            type: 'PROJECT_ARCHIVED',
            title: `Project "${updated.name}" has been archived`,
            body: 'The project is now read-only. Restore it to make changes again.',
            resourceType: 'Project',
            resourceId: projectId,
        }).catch(() => {});

        return new ProjectEntity(updated);
    }

    async softDelete(orgId: string, projectId: string) {
        await this.ensureProjectExists(orgId, projectId);

        const updated = await this.prisma.project.update({
            where: { id: projectId },
            data: { deletedAt: new Date() },
        });

        return new ProjectEntity(updated);
    }

    async restore(orgId: string, projectId: string) {
        const project = await this.prisma.project.findFirst({
            where: { id: projectId, organizationId: orgId },
        });

        if (!project) {
            throw new NotFoundException('Project not found');
        }

        if (!project.deletedAt) {
            throw new BadRequestException('Project is not deleted');
        }

        const updated = await this.prisma.project.update({
            where: { id: projectId },
            data: { deletedAt: null, status: 'ACTIVE' },
        });

        return new ProjectEntity(updated);
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private async notifyOrgMembers(
        organizationId: string,
        dto: {
            type: 'PROJECT_ARCHIVED';
            title: string;
            body: string;
            resourceType: string;
            resourceId: string;
        },
    ) {
        const members = await this.prisma.membership.findMany({
            where: { organizationId },
            select: { userId: true },
        });

        await this.notificationsService.createAndEmitMany(
            members.map((m) => m.userId),
            dto,
        );
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
