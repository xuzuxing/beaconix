import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { ProjectAccessService } from '../../../common/authorization/project-access.service';
import type { Prisma } from '../../../generated/prisma/client';
import { RumErrorStatus } from '../../../generated/prisma/enums';
import { PrismaService } from '../../../infra/database/prisma.service';
import type {
    CreateRumErrorNoteDto,
    QueryRumErrorNotesDto,
    QueryRumErrorOccurrencesDto,
    QueryRumErrorsDto,
    UpdateRumErrorDto,
} from '../dto';

@Injectable()
export class RumErrorsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ProjectAccessService,
    ) {}

    async findAll(
        projectId: string,
        appId: string,
        query: QueryRumErrorsDto,
        principal: AccessPrincipal,
    ) {
        const access = await this.access.project(
            principal,
            projectId,
            'rum.read',
        );
        await this.ensureApp(access.organizationId, projectId, appId);

        const from = query.from ? new Date(query.from) : undefined;
        const to = query.to ? new Date(query.to) : undefined;
        if (from && to && from > to) {
            throw new BadRequestException('from must not be after to');
        }

        const where: Prisma.RumErrorGroupWhereInput = {
            appId,
            ...(query.status && query.status !== 'ALL'
                ? { status: query.status }
                : {}),
            ...(query.type ? { type: query.type } : {}),
            ...(query.release ? { release: query.release } : {}),
            ...(query.search
                ? {
                      OR: [
                          {
                              message: {
                                  contains: query.search,
                                  mode: 'insensitive',
                              },
                          },
                          {
                              type: {
                                  contains: query.search,
                                  mode: 'insensitive',
                              },
                          },
                      ],
                  }
                : {}),
            ...(from || to
                ? {
                      lastSeenAt: {
                          ...(from ? { gte: from } : {}),
                          ...(to ? { lte: to } : {}),
                      },
                  }
                : {}),
        };
        const orderBy = {
            [query.sortBy]: query.sortOrder,
        } as Prisma.RumErrorGroupOrderByWithRelationInput;
        const [items, total] = await this.prisma.$transaction([
            this.prisma.rumErrorGroup.findMany({
                where,
                orderBy,
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
            this.prisma.rumErrorGroup.count({ where }),
        ]);
        return { items, total, page: query.page, limit: query.limit };
    }

    async findOne(
        projectId: string,
        appId: string,
        errorId: string,
        principal: AccessPrincipal,
    ) {
        const access = await this.access.project(
            principal,
            projectId,
            'rum.read',
        );
        await this.ensureApp(access.organizationId, projectId, appId);
        const error = await this.prisma.rumErrorGroup.findFirst({
            where: { id: errorId, appId },
        });
        if (!error) throw new NotFoundException('RUM error not found');
        return error;
    }

    async findOccurrences(
        projectId: string,
        appId: string,
        errorId: string,
        query: QueryRumErrorOccurrencesDto,
        principal: AccessPrincipal,
    ) {
        const access = await this.access.project(
            principal,
            projectId,
            'rum.read',
        );
        await this.ensureApp(access.organizationId, projectId, appId);
        const group = await this.prisma.rumErrorGroup.findFirst({
            where: { id: errorId, appId },
            select: { id: true },
        });
        if (!group) throw new NotFoundException('RUM error not found');
        const where: Prisma.RumErrorOccurrenceWhereInput = {
            groupId: errorId,
            appId,
        };
        const [items, total] = await this.prisma.$transaction([
            this.prisma.rumErrorOccurrence.findMany({
                where,
                orderBy: { receivedAt: 'desc' },
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
            this.prisma.rumErrorOccurrence.count({ where }),
        ]);
        return { items, total, page: query.page, limit: query.limit };
    }

    async update(
        projectId: string,
        appId: string,
        errorId: string,
        dto: UpdateRumErrorDto,
        principal: AccessPrincipal,
    ) {
        const access = await this.access.project(
            principal,
            projectId,
            'rum.read',
        );
        await this.ensureApp(access.organizationId, projectId, appId);

        const assigningSomeoneElse =
            dto.assigneeId !== undefined &&
            dto.assigneeId !== null &&
            (principal.type !== 'USER' || principal.userId !== dto.assigneeId);
        if (assigningSomeoneElse) {
            // Assigning another member is an administrative action; changing
            // status stays available to anyone who can read RUM data.
            await this.access.project(principal, projectId, 'app.manage');
        }

        const current = await this.prisma.rumErrorGroup.findFirst({
            where: { id: errorId, appId },
            select: { id: true },
        });
        if (!current) throw new NotFoundException('RUM error not found');

        if (dto.assigneeId) {
            const member = await this.prisma.membership.findFirst({
                where: {
                    userId: dto.assigneeId,
                    organizationId: access.organizationId,
                    user: { deletedAt: null },
                },
                select: { id: true },
            });
            if (!member)
                throw new BadRequestException(
                    'Assignee must be an active organization member',
                );
        }

        const now = new Date();
        const actorId = principal.type === 'USER' ? principal.userId : null;
        const data: Prisma.RumErrorGroupUncheckedUpdateInput = {};

        if (dto.status !== undefined) {
            data.status = dto.status;
            if (dto.status === RumErrorStatus.RESOLVED) {
                data.resolvedAt = now;
                data.resolvedBy = actorId;
            } else {
                data.resolvedAt = null;
                data.resolvedBy = null;
            }
            data.ignoredUntil =
                dto.status === RumErrorStatus.IGNORED && dto.ignoredUntil
                    ? new Date(dto.ignoredUntil)
                    : null;
        } else if (dto.ignoredUntil !== undefined) {
            data.ignoredUntil = dto.ignoredUntil
                ? new Date(dto.ignoredUntil)
                : null;
        }

        if (dto.assigneeId !== undefined) {
            data.assigneeId = dto.assigneeId;
        }

        return this.prisma.rumErrorGroup.update({
            where: { id: current.id },
            data,
            include: {
                assignee: { select: { id: true, name: true, email: true } },
                resolver: { select: { id: true, name: true, email: true } },
            },
        });
    }

    async notes(
        projectId: string,
        appId: string,
        errorId: string,
        query: QueryRumErrorNotesDto,
        principal: AccessPrincipal,
    ) {
        const access = await this.access.project(
            principal,
            projectId,
            'rum.read',
        );
        await this.ensureApp(access.organizationId, projectId, appId);
        await this.ensureGroup(appId, errorId);
        const where: Prisma.RumErrorNoteWhereInput = {
            appId,
            groupId: errorId,
        };
        const [items, total] = await this.prisma.$transaction([
            this.prisma.rumErrorNote.findMany({
                where,
                include: {
                    author: { select: { id: true, name: true, email: true } },
                },
                orderBy: { createdAt: 'desc' },
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
            this.prisma.rumErrorNote.count({ where }),
        ]);
        return { items, total, page: query.page, limit: query.limit };
    }

    async createNote(
        projectId: string,
        appId: string,
        errorId: string,
        dto: CreateRumErrorNoteDto,
        principal: AccessPrincipal,
    ) {
        const access = await this.access.project(
            principal,
            projectId,
            'rum.read',
        );
        await this.ensureApp(access.organizationId, projectId, appId);
        await this.ensureGroup(appId, errorId);
        const body = dto.body.trim();
        if (!body) throw new BadRequestException('Note body must not be blank');
        return this.prisma.rumErrorNote.create({
            data: {
                appId,
                groupId: errorId,
                authorId: principal.type === 'USER' ? principal.userId : null,
                body,
            },
            include: {
                author: { select: { id: true, name: true, email: true } },
            },
        });
    }

    async removeNote(
        projectId: string,
        appId: string,
        errorId: string,
        noteId: string,
        principal: AccessPrincipal,
    ): Promise<void> {
        const access = await this.access.project(
            principal,
            projectId,
            'rum.read',
        );
        await this.ensureApp(access.organizationId, projectId, appId);
        const note = await this.prisma.rumErrorNote.findFirst({
            where: { id: noteId, appId, groupId: errorId },
            select: { id: true, authorId: true },
        });
        if (!note) throw new NotFoundException('RUM error note not found');
        const isAuthor =
            principal.type === 'USER' && principal.userId === note.authorId;
        if (!isAuthor) {
            // Only the author or an app administrator may delete a note.
            await this.access.project(principal, projectId, 'app.manage');
        }
        await this.prisma.rumErrorNote.delete({ where: { id: note.id } });
    }

    private async ensureGroup(appId: string, groupId: string): Promise<void> {
        const group = await this.prisma.rumErrorGroup.findFirst({
            where: { id: groupId, appId },
            select: { id: true },
        });
        if (!group) throw new NotFoundException('RUM error not found');
    }

    private async ensureApp(
        organizationId: string,
        projectId: string,
        appId: string,
    ): Promise<void> {
        const app = await this.prisma.rumApp.findFirst({
            where: {
                id: appId,
                organizationId,
                projectId,
                deletedAt: null,
            },
            select: { id: true },
        });
        if (!app) throw new NotFoundException('RUM app not found');
    }
}
