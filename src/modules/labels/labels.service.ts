import {
    Injectable,
    NotFoundException,
    ConflictException,
    BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { CreateLabelDto, UpdateLabelDto } from './dto';
import { LabelEntity } from './entities';
import { ProjectAccessService } from '../../common/authorization/project-access.service';
import type { AccessPrincipal } from '../../common/authorization/access.types';
import type { AccessDb } from '../../common/authorization/access-locks';

const creatorSelect = { id: true, name: true } as const;

@Injectable()
export class LabelsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ProjectAccessService,
    ) {}

    // ── ORG LABELS ──────────────────────────────────────────────────────

    async findOrgLabels(orgId: string, principal: AccessPrincipal) {
        const project = await this.access.projectFilter(principal, orgId);
        const labels = await this.prisma.label.findMany({
            where: { organizationId: orgId, projectId: null },
            include: {
                createdBy: { select: creatorSelect },
                _count: {
                    select: {
                        tasks: {
                            where: { task: { deletedAt: null, project } },
                        },
                    },
                },
            },
            orderBy: { name: 'asc' },
        });

        return labels.map((l) => new LabelEntity(l));
    }

    async createOrgLabel(orgId: string, userId: string, dto: CreateLabelDto) {
        return this.access.withOrganization(
            { type: 'USER', userId },
            orgId,
            async (tx) => {
                await this.checkDuplicateLabel(dto.name, orgId, null, tx);

                const label = await tx.label.create({
                    data: {
                        name: dto.name,
                        color: dto.color,
                        organizationId: orgId,
                        projectId: null,
                        createdById: userId,
                    },
                    include: {
                        createdBy: { select: creatorSelect },
                        _count: {
                            select: {
                                tasks: {
                                    where: {
                                        task: {
                                            deletedAt: null,
                                            organizationId: orgId,
                                        },
                                    },
                                },
                            },
                        },
                    },
                });

                return new LabelEntity(label);
            },
        );
    }

    // ── PROJECT LABELS ──────────────────────────────────────────────────

    async findProjectLabels(projectId: string, principal: AccessPrincipal) {
        const access = await this.access.project(principal, projectId);

        const labels = await this.prisma.label.findMany({
            where: { projectId, organizationId: access.organizationId },
            include: {
                createdBy: { select: creatorSelect },
                _count: {
                    select: {
                        tasks: {
                            where: {
                                task: {
                                    projectId,
                                    organizationId: access.organizationId,
                                    deletedAt: null,
                                },
                            },
                        },
                    },
                },
            },
            orderBy: { name: 'asc' },
        });

        return labels.map((l) => new LabelEntity(l));
    }

    async createProjectLabel(
        projectId: string,
        userId: string,
        dto: CreateLabelDto,
    ) {
        return this.access.withProject(
            { type: 'USER', userId },
            projectId,
            'label.manage',
            async (tx, project) => {
                await this.checkDuplicateLabel(
                    dto.name,
                    project.organizationId,
                    projectId,
                    tx,
                );

                const label = await tx.label.create({
                    data: {
                        name: dto.name,
                        color: dto.color,
                        organizationId: project.organizationId,
                        projectId,
                        createdById: userId,
                    },
                    include: {
                        createdBy: { select: creatorSelect },
                        _count: {
                            select: {
                                tasks: {
                                    where: {
                                        task: {
                                            projectId,
                                            organizationId:
                                                project.organizationId,
                                            deletedAt: null,
                                        },
                                    },
                                },
                            },
                        },
                    },
                });

                return new LabelEntity(label);
            },
        );
    }

    // ── UPDATE / DELETE ─────────────────────────────────────────────────

    async update(
        labelId: string,
        dto: UpdateLabelDto,
        principal: AccessPrincipal,
    ) {
        const label = await this.findLabelOrFail(labelId);
        return this.withLabel(label, principal, async (tx) => {
            const current = await this.findLabelOrFail(labelId, tx);

            if (dto.name && dto.name !== current.name) {
                await this.checkDuplicateLabel(
                    dto.name,
                    label.organizationId,
                    label.projectId,
                    tx,
                );
            }

            const updated = await tx.label.update({
                where: {
                    id: labelId,
                    organizationId: label.organizationId,
                    projectId: label.projectId,
                },
                data: dto,
                include: {
                    createdBy: { select: creatorSelect },
                    _count: {
                        select: {
                            tasks: {
                                where: {
                                    task: {
                                        deletedAt: null,
                                        organizationId: label.organizationId,
                                        ...(label.projectId
                                            ? { projectId: label.projectId }
                                            : {}),
                                    },
                                },
                            },
                        },
                    },
                },
            });

            return new LabelEntity(updated);
        });
    }

    async remove(labelId: string, principal: AccessPrincipal) {
        const label = await this.findLabelOrFail(labelId);
        await this.withLabel(label, principal, (tx) =>
            tx.label.delete({
                where: {
                    id: labelId,
                    organizationId: label.organizationId,
                    projectId: label.projectId,
                },
            }),
        );
    }

    // ── TASK LABELING ───────────────────────────────────────────────────

    async tagTask(taskId: string, labelId: string, principal: AccessPrincipal) {
        await this.access.withTask(
            principal,
            taskId,
            'task.write',
            async (tx, _access, task) => {
                const label = await this.findLabelOrFail(labelId, tx);

                // Ensure the label belongs to the same organization as the task
                if (
                    label.organizationId !== task.organizationId ||
                    (label.projectId && label.projectId !== task.projectId)
                ) {
                    throw new BadRequestException(
                        'Label does not belong to the same organization as the task',
                    );
                }

                const existing = await tx.taskLabel.findUnique({
                    where: { taskId_labelId: { taskId, labelId } },
                });

                if (existing) {
                    throw new ConflictException(
                        'This label is already on the task',
                    );
                }

                await tx.taskLabel.create({
                    data: { taskId, labelId },
                });
            },
        );
    }

    async untagTask(
        taskId: string,
        labelId: string,
        principal: AccessPrincipal,
    ) {
        await this.access.withTask(
            principal,
            taskId,
            'task.write',
            async (tx, _access, task) => {
                const label = await this.findLabelOrFail(labelId, tx);
                if (
                    label.organizationId !== task.organizationId ||
                    (label.projectId && label.projectId !== task.projectId)
                ) {
                    throw new NotFoundException('Label not found');
                }

                const existing = await tx.taskLabel.findUnique({
                    where: { taskId_labelId: { taskId, labelId } },
                });

                if (!existing) {
                    throw new NotFoundException(
                        'This label is not on the task',
                    );
                }

                await tx.taskLabel.delete({
                    where: { taskId_labelId: { taskId, labelId } },
                });
            },
        );
    }

    // ── HELPERS ─────────────────────────────────────────────────────────

    /** Returns the label's orgId so guards can resolve org context */
    async getLabelOrgId(labelId: string): Promise<string> {
        const label = await this.prisma.label.findUnique({
            where: { id: labelId },
            select: { organizationId: true },
        });
        if (!label) throw new NotFoundException('Label not found');
        return label.organizationId;
    }

    private async findLabelOrFail(labelId: string, db: AccessDb = this.prisma) {
        const label = await db.label.findUnique({
            where: { id: labelId },
        });
        if (!label) throw new NotFoundException('Label not found');
        return label;
    }

    private async checkDuplicateLabel(
        name: string,
        organizationId: string,
        projectId: string | null,
        db: AccessDb = this.prisma,
    ) {
        const existing = await db.label.findFirst({
            where: { name, organizationId, projectId },
        });
        if (existing) {
            throw new ConflictException(
                `A label named "${name}" already exists in this scope`,
            );
        }
    }

    private withLabel<T>(
        label: { projectId: string | null; organizationId: string },
        principal: AccessPrincipal,
        work: (tx: AccessDb) => Promise<T>,
    ) {
        return label.projectId
            ? this.access.withProjectWrite(
                  principal,
                  label.organizationId,
                  label.projectId,
                  'label.manage',
                  work,
              )
            : this.access.withOrganization(
                  principal,
                  label.organizationId,
                  work,
              );
    }
}
