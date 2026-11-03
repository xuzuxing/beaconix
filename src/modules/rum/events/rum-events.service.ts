import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { ProjectAccessService } from '../../../common/authorization/project-access.service';
import { Prisma } from '../../../generated/prisma/client';
import { RumMetricKind } from '../../../generated/prisma/enums';
import { PrismaService } from '../../../infra/database/prisma.service';
import type {
    QueryRumEventsDto,
    QueryRumEventStatsDto,
    ReportRumEventDto,
} from '../dto';
import { sanitizeRumJson, sanitizeRumPage } from '../ingest/ingest-sanitizer';
import { RumPublicIngestService } from '../ingest/rum-public-ingest.service';
import { incrementRumMetric } from '../metrics/rum-metric-bucket';

const MAX_PROPERTIES_BYTES = 16 * 1024;

@Injectable()
export class RumEventsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ProjectAccessService,
        private readonly publicIngest: RumPublicIngestService,
    ) {}

    report(dto: ReportRumEventDto, source: string) {
        const properties = sanitizeRumJson(
            dto.properties ?? {},
        ) as Prisma.InputJsonValue;
        const size = Buffer.byteLength(JSON.stringify(properties), 'utf8');
        if (size > MAX_PROPERTIES_BYTES)
            throw new BadRequestException(
                `Event properties exceed ${MAX_PROPERTIES_BYTES} bytes`,
            );
        return this.publicIngest.withActiveApp(
            dto.publicKey,
            source,
            async (tx, app) => {
                const receivedAt = new Date();
                await tx.rumEvent.create({
                    data: {
                        appId: app.id,
                        eventName: dto.eventName,
                        endUserId: dto.userId?.trim() || null,
                        anonymousId: dto.anonymousId?.trim() || null,
                        sessionId: dto.sessionId?.trim() || null,
                        release: dto.release?.trim() || null,
                        page: sanitizeRumPage(dto.page),
                        properties,
                        occurredAt: dto.occurredAt
                            ? new Date(dto.occurredAt)
                            : null,
                        receivedAt,
                    },
                });
                // Keep a stable row-lock order for concurrent identical events.
                await incrementRumMetric(
                    tx,
                    app.id,
                    RumMetricKind.EVENT,
                    dto.eventName,
                    receivedAt,
                );
                await incrementRumMetric(
                    tx,
                    app.id,
                    RumMetricKind.EVENT,
                    '*',
                    receivedAt,
                );
                return { accepted: true };
            },
        );
    }

    async findAll(
        projectId: string,
        appId: string,
        query: QueryRumEventsDto,
        principal: AccessPrincipal,
    ) {
        await this.authorize(projectId, appId, principal);
        const from = query.from ? new Date(query.from) : undefined;
        const to = query.to ? new Date(query.to) : undefined;
        if (from && to && from > to)
            throw new BadRequestException('from must not be after to');
        const where: Prisma.RumEventWhereInput = {
            appId,
            ...(query.eventName ? { eventName: query.eventName } : {}),
            ...(query.sessionId ? { sessionId: query.sessionId } : {}),
            ...(from || to
                ? {
                      receivedAt: {
                          ...(from ? { gte: from } : {}),
                          ...(to ? { lte: to } : {}),
                      },
                  }
                : {}),
        };
        const [items, total] = await this.prisma.$transaction([
            this.prisma.rumEvent.findMany({
                where,
                orderBy: { receivedAt: 'desc' },
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
            this.prisma.rumEvent.count({ where }),
        ]);
        return { items, total, page: query.page, limit: query.limit };
    }

    async stats(
        projectId: string,
        appId: string,
        query: QueryRumEventStatsDto,
        principal: AccessPrincipal,
    ) {
        await this.authorize(projectId, appId, principal);
        const since = new Date(Date.now() - query.days * 86_400_000);
        const filter = query.eventName
            ? Prisma.sql`AND "eventName" = ${query.eventName}`
            : Prisma.empty;
        const [summary] = await this.prisma.$queryRaw<
            Array<{
                total: bigint;
                uniqueActors: bigint;
                uniqueSessions: bigint;
            }>
        >(Prisma.sql`
            SELECT
                COUNT(*)::bigint AS total,
                COUNT(DISTINCT COALESCE("endUserId", "anonymousId"))::bigint AS "uniqueActors",
                COUNT(DISTINCT "sessionId")::bigint AS "uniqueSessions"
            FROM "rum_events"
            WHERE "appId" = ${appId} AND "receivedAt" >= ${since} ${filter}
        `);
        const daily = await this.prisma.$queryRaw<
            Array<{ day: Date; count: bigint }>
        >(Prisma.sql`
            SELECT date_trunc('day', "receivedAt") AS day, COUNT(*)::bigint AS count
            FROM "rum_events"
            WHERE "appId" = ${appId} AND "receivedAt" >= ${since} ${filter}
            GROUP BY day ORDER BY day ASC
        `);
        const topEvents = await this.prisma.rumEvent.groupBy({
            by: ['eventName'],
            where: {
                appId,
                receivedAt: { gte: since },
                ...(query.eventName ? { eventName: query.eventName } : {}),
            },
            _count: { _all: true },
            orderBy: { _count: { eventName: 'desc' } },
            take: 10,
        });
        return {
            days: query.days,
            eventName: query.eventName ?? null,
            total: Number(summary?.total ?? 0),
            uniqueActors: Number(summary?.uniqueActors ?? 0),
            uniqueSessions: Number(summary?.uniqueSessions ?? 0),
            daily: daily.map((row) => ({
                day: row.day.toISOString().slice(0, 10),
                count: Number(row.count),
            })),
            topEvents: topEvents.map((row) => ({
                eventName: row.eventName,
                count: row._count._all,
            })),
        };
    }

    private async authorize(
        projectId: string,
        appId: string,
        principal: AccessPrincipal,
    ) {
        const access = await this.access.project(
            principal,
            projectId,
            'rum.read',
        );
        const app = await this.prisma.rumApp.findFirst({
            where: {
                id: appId,
                projectId,
                organizationId: access.organizationId,
                deletedAt: null,
            },
            select: { id: true },
        });
        if (!app) throw new NotFoundException('RUM app not found');
    }
}
