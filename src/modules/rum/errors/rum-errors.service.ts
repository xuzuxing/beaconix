import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { ProjectAccessService } from '../../../common/authorization/project-access.service';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../infra/database/prisma.service';
import type { QueryRumErrorOccurrencesDto, QueryRumErrorsDto } from '../dto';

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
