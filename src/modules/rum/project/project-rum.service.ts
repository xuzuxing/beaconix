import { BadRequestException, Injectable } from '@nestjs/common';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { ProjectAccessService } from '../../../common/authorization/project-access.service';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../infra/database/prisma.service';
import type {
    QueryProjectRumErrorsDto,
    QueryProjectRumEventsDto,
} from './query-project-rum.dto';

@Injectable()
export class ProjectRumService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ProjectAccessService,
    ) {}

    private async scope(projectId: string, principal: AccessPrincipal) {
        const access = await this.access.project(
            principal,
            projectId,
            'rum.read',
        );
        return {
            organizationId: access.organizationId,
            projectId,
            deletedAt: null,
        };
    }

    private range(from?: string, to?: string) {
        const start = from ? new Date(from) : undefined;
        const end = to ? new Date(to) : undefined;
        if (start && end && start > end)
            throw new BadRequestException('from must not be after to');
        return start || end
            ? { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) }
            : undefined;
    }

    async overview(projectId: string, principal: AccessPrincipal) {
        const scope = await this.scope(projectId, principal);
        const since = new Date(Date.now() - 7 * 86_400_000);
        const [
            apps,
            errorGroups,
            events7d,
            replays,
            openAlerts,
            errorsByApp,
            eventsByApp,
        ] = await this.prisma.$transaction([
            this.prisma.rumApp.findMany({
                where: scope,
                select: { id: true, name: true, enabled: true },
                orderBy: { name: 'asc' },
            }),
            this.prisma.rumErrorGroup.count({ where: { app: scope } }),
            this.prisma.rumEvent.count({
                where: { app: scope, receivedAt: { gte: since } },
            }),
            this.prisma.rumReplaySession.count({ where: { app: scope } }),
            this.prisma.rumAlertIncident.count({
                where: { app: scope, status: 'OPEN' },
            }),
            this.prisma.rumErrorGroup.groupBy({
                by: ['appId'],
                where: { app: scope },
                _count: { _all: true },
            }),
            this.prisma.rumEvent.groupBy({
                by: ['appId'],
                where: { app: scope, receivedAt: { gte: since } },
                _count: { _all: true },
            }),
        ]);
        return {
            appCount: apps.length,
            errorGroups,
            events7d,
            replays,
            openAlerts,
            apps: apps.map((app) => ({
                ...app,
                errorGroups:
                    errorsByApp.find((x) => x.appId === app.id)?._count._all ??
                    0,
                events7d:
                    eventsByApp.find((x) => x.appId === app.id)?._count._all ??
                    0,
            })),
        };
    }

    async errors(
        projectId: string,
        query: QueryProjectRumErrorsDto,
        principal: AccessPrincipal,
    ) {
        const scope = await this.scope(projectId, principal);
        const date = this.range(query.from, query.to);
        const where: Prisma.RumErrorGroupWhereInput = {
            app: { ...scope, ...(query.appId ? { id: query.appId } : {}) },
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
            ...(date ? { lastSeenAt: date } : {}),
        };
        const [items, total] = await this.prisma.$transaction([
            this.prisma.rumErrorGroup.findMany({
                where,
                include: { app: { select: { id: true, name: true } } },
                orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'desc' }],
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
            this.prisma.rumErrorGroup.count({ where }),
        ]);
        return { items, total, page: query.page, limit: query.limit };
    }

    async events(
        projectId: string,
        query: QueryProjectRumEventsDto,
        principal: AccessPrincipal,
    ) {
        const scope = await this.scope(projectId, principal);
        const date = this.range(query.from, query.to);
        const where: Prisma.RumEventWhereInput = {
            app: { ...scope, ...(query.appId ? { id: query.appId } : {}) },
            ...(query.eventName ? { eventName: query.eventName } : {}),
            ...(query.sessionId ? { sessionId: query.sessionId } : {}),
            ...(date ? { receivedAt: date } : {}),
        };
        const [items, total] = await this.prisma.$transaction([
            this.prisma.rumEvent.findMany({
                where,
                include: { app: { select: { id: true, name: true } } },
                orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
            this.prisma.rumEvent.count({ where }),
        ]);
        return { items, total, page: query.page, limit: query.limit };
    }
}
