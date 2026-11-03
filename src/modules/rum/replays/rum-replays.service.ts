import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { ProjectAccessService } from '../../../common/authorization/project-access.service';
import type { RumConfig } from '../../../config';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../infra/database/prisma.service';
import type {
    QueryRumReplayChunksDto,
    QueryRumReplaysDto,
    ReportRumReplayDto,
} from '../dto';
import { sanitizeRumJson, sanitizeRumPage } from '../ingest/ingest-sanitizer';
import { RumPublicIngestService } from '../ingest/rum-public-ingest.service';

@Injectable()
export class RumReplaysService {
    private readonly config: RumConfig;

    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ProjectAccessService,
        private readonly publicIngest: RumPublicIngestService,
        configService: ConfigService,
    ) {
        this.config = configService.get<RumConfig>('rum')!;
    }

    report(dto: ReportRumReplayDto, source: string) {
        const events = sanitizeRumJson(dto.events) as Prisma.InputJsonArray;
        const serialized = JSON.stringify(events);
        const sizeBytes = Buffer.byteLength(serialized, 'utf8');
        if (sizeBytes > this.config.replayMaxPayloadBytes)
            throw new BadRequestException(
                `Replay chunk exceeds ${this.config.replayMaxPayloadBytes} bytes`,
            );
        return this.publicIngest.withActiveApp(
            dto.publicKey,
            source,
            async (tx, app) => {
                const receivedAt = new Date();
                const session = await tx.rumReplaySession.upsert({
                    where: {
                        appId_sessionKey: {
                            appId: app.id,
                            sessionKey: dto.sessionId,
                        },
                    },
                    create: {
                        appId: app.id,
                        sessionKey: dto.sessionId,
                        release: dto.release?.trim() || null,
                        page: sanitizeRumPage(dto.page),
                        startedAt: new Date(dto.startedAt),
                        lastSeenAt: receivedAt,
                    },
                    update: {
                        lastSeenAt: receivedAt,
                        ...(dto.release ? { release: dto.release.trim() } : {}),
                        ...(dto.page
                            ? { page: sanitizeRumPage(dto.page) }
                            : {}),
                    },
                    select: { id: true },
                });
                const inserted = await tx.rumReplayChunk.createMany({
                    data: [
                        {
                            sessionId: session.id,
                            sequence: dto.sequence,
                            events,
                            eventCount: events.length,
                            sizeBytes,
                            occurredAt: new Date(dto.occurredAt),
                        },
                    ],
                    skipDuplicates: true,
                });
                if (inserted.count) {
                    await tx.rumReplaySession.update({
                        where: { id: session.id },
                        data: {
                            chunkCount: { increment: 1 },
                            eventCount: { increment: events.length },
                            sizeBytes: { increment: sizeBytes },
                        },
                    });
                }
                return { accepted: true, duplicate: inserted.count === 0 };
            },
        );
    }

    async findAll(
        projectId: string,
        appId: string,
        query: QueryRumReplaysDto,
        principal: AccessPrincipal,
    ) {
        await this.authorize(projectId, appId, principal);
        const from = query.from ? new Date(query.from) : undefined;
        const to = query.to ? new Date(query.to) : undefined;
        if (from && to && from > to)
            throw new BadRequestException('from must not be after to');
        const where: Prisma.RumReplaySessionWhereInput = {
            appId,
            ...(query.release ? { release: query.release } : {}),
            ...(from || to
                ? {
                      lastSeenAt: {
                          ...(from ? { gte: from } : {}),
                          ...(to ? { lte: to } : {}),
                      },
                  }
                : {}),
        };
        const [items, total] = await this.prisma.$transaction([
            this.prisma.rumReplaySession.findMany({
                where,
                orderBy: { lastSeenAt: 'desc' },
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
            this.prisma.rumReplaySession.count({ where }),
        ]);
        return { items, total, page: query.page, limit: query.limit };
    }

    async findOne(
        projectId: string,
        appId: string,
        replayId: string,
        principal: AccessPrincipal,
    ) {
        await this.authorize(projectId, appId, principal);
        const replay = await this.prisma.rumReplaySession.findFirst({
            where: { id: replayId, appId },
        });
        if (!replay) throw new NotFoundException('RUM replay not found');
        return replay;
    }

    async chunks(
        projectId: string,
        appId: string,
        replayId: string,
        query: QueryRumReplayChunksDto,
        principal: AccessPrincipal,
    ) {
        await this.findOne(projectId, appId, replayId, principal);
        const items = await this.prisma.rumReplayChunk.findMany({
            where: {
                sessionId: replayId,
                sequence: { gt: query.afterSequence },
            },
            orderBy: { sequence: 'asc' },
            take: query.limit,
        });
        return { items, nextSequence: items.at(-1)?.sequence ?? null };
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
