import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { ProjectAccessService } from '../../../common/authorization/project-access.service';
import type { RumConfig } from '../../../config';
import { PrismaService } from '../../../infra/database/prisma.service';
import type { UploadRumSourceMapDto } from '../dto';
import { ParsedSourceMap, parseSourceMap } from './source-map-consumer';

interface CachedMap {
    updatedAt: number;
    map: ParsedSourceMap;
}

const MAX_SOURCE_MAP_CACHE_ENTRIES = 200;

export interface SymbolicatedStack {
    stack: string;
    applied: boolean;
}

@Injectable()
export class RumSourceMapsService {
    private readonly config: RumConfig;
    private readonly cache = new Map<string, CachedMap>();

    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ProjectAccessService,
        configService: ConfigService,
    ) {
        this.config = configService.get<RumConfig>('rum')!;
    }

    async upload(
        projectId: string,
        appId: string,
        dto: UploadRumSourceMapDto,
        file: Express.Multer.File | undefined,
        principal: AccessPrincipal,
    ) {
        if (!file) throw new BadRequestException('Source map file is required');
        if (file.size > this.config.sourceMapMaxBytes)
            throw new BadRequestException(
                `Source map exceeds ${this.config.sourceMapMaxBytes} bytes`,
            );
        const content = file.buffer.toString('utf8');
        let parsedMap: ParsedSourceMap;
        try {
            parsedMap = parseSourceMap(content);
        } catch (error) {
            throw new BadRequestException((error as Error).message);
        }
        const artifactPath = normalizeArtifactPath(dto.artifactPath);
        const release = dto.release.trim();
        if (!release) throw new BadRequestException('release is required');
        return this.access.withProject(
            principal,
            projectId,
            'app.manage',
            async (tx, access) => {
                await this.ensureApp(
                    tx,
                    access.organizationId,
                    projectId,
                    appId,
                );
                const result = await tx.rumSourceMap.upsert({
                    where: {
                        appId_release_artifactPath: {
                            appId,
                            release,
                            artifactPath,
                        },
                    },
                    create: {
                        appId,
                        release,
                        artifactPath,
                        content,
                        checksum: createHash('sha256')
                            .update(file.buffer)
                            .digest('hex'),
                        sizeBytes: file.size,
                        uploadedById:
                            principal.type === 'USER' ? principal.userId : null,
                    },
                    update: {
                        content,
                        checksum: createHash('sha256')
                            .update(file.buffer)
                            .digest('hex'),
                        sizeBytes: file.size,
                        uploadedById:
                            principal.type === 'USER' ? principal.userId : null,
                    },
                    select: publicSelect,
                });
                this.cache.delete(result.id);
                const reprocessed = await this.reprocessExistingGroups(
                    tx,
                    appId,
                    release,
                    artifactPath,
                    parsedMap,
                );
                return { ...result, reprocessed };
            },
        );
    }

    async findAll(
        projectId: string,
        appId: string,
        principal: AccessPrincipal,
    ) {
        const access = await this.access.project(
            principal,
            projectId,
            'app.read',
        );
        await this.ensureApp(
            this.prisma,
            access.organizationId,
            projectId,
            appId,
        );
        return this.prisma.rumSourceMap.findMany({
            where: { appId },
            select: publicSelect,
            orderBy: { updatedAt: 'desc' },
        });
    }

    async remove(
        projectId: string,
        appId: string,
        sourceMapId: string,
        principal: AccessPrincipal,
    ): Promise<void> {
        await this.access.withProject(
            principal,
            projectId,
            'app.manage',
            async (tx, access) => {
                await this.ensureApp(
                    tx,
                    access.organizationId,
                    projectId,
                    appId,
                );
                const result = await tx.rumSourceMap.deleteMany({
                    where: { id: sourceMapId, appId },
                });
                if (!result.count)
                    throw new NotFoundException('Source map not found');
                this.cache.delete(sourceMapId);
            },
        );
    }

    async symbolicate(
        appId: string,
        release: string | null,
        stack: string | null,
        db: Pick<PrismaService, 'rumSourceMap'> = this.prisma,
    ): Promise<SymbolicatedStack> {
        if (!release || !stack) return { stack: stack ?? '', applied: false };
        const rows = await db.rumSourceMap.findMany({
            where: { appId, release },
        });
        if (!rows.length) return { stack, applied: false };
        const maps = new Map(
            rows.map((row) => [
                row.artifactPath,
                this.cached(row.id, row.updatedAt, row.content),
            ]),
        );
        let applied = false;
        const resolved = stack
            .split('\n')
            .map((line) =>
                line.replace(
                    /((?:https?:\/\/|file:\/\/\/|\/)[^\s()]+):(\d+):(\d+)/g,
                    (
                        location,
                        file: string,
                        lineValue: string,
                        columnValue: string,
                    ) => {
                        const map = maps.get(normalizeArtifactPath(file));
                        if (!map) return location;
                        const original = map.originalPositionFor(
                            Number(lineValue),
                            Math.max(0, Number(columnValue) - 1),
                        );
                        if (!original) return location;
                        applied = true;
                        return `${original.source}:${original.line}:${original.column}`;
                    },
                ),
            )
            .join('\n');
        return { stack: resolved, applied };
    }

    private async reprocessExistingGroups(
        db: Pick<PrismaService, 'rumErrorGroup'>,
        appId: string,
        release: string,
        artifactPath: string,
        map: ParsedSourceMap,
    ): Promise<number> {
        const groups = await db.rumErrorGroup.findMany({
            where: {
                appId,
                release,
                sourceMapApplied: false,
                stack: { contains: artifactPath },
            },
            select: { id: true, stack: true },
            orderBy: { lastSeenAt: 'desc' },
            take: 500,
        });
        let updated = 0;
        for (const group of groups) {
            if (!group.stack) continue;
            const resolved = this.symbolicateWithMap(
                group.stack,
                artifactPath,
                map,
            );
            if (!resolved.applied) continue;
            await db.rumErrorGroup.update({
                where: { id: group.id },
                data: {
                    resolvedStack: resolved.stack,
                    sourceMapApplied: true,
                },
            });
            updated++;
        }
        return updated;
    }

    private symbolicateWithMap(
        stack: string,
        artifactPath: string,
        map: ParsedSourceMap,
    ): SymbolicatedStack {
        let applied = false;
        const resolved = stack
            .split('\n')
            .map((line) =>
                line.replace(
                    /((?:https?:\/\/|file:\/\/\/|\/)[^\s()]+):(\d+):(\d+)/g,
                    (
                        location,
                        file: string,
                        lineValue: string,
                        columnValue: string,
                    ) => {
                        if (normalizeArtifactPath(file) !== artifactPath)
                            return location;
                        const original = map.originalPositionFor(
                            Number(lineValue),
                            Math.max(0, Number(columnValue) - 1),
                        );
                        if (!original) return location;
                        applied = true;
                        return `${original.source}:${original.line}:${original.column}`;
                    },
                ),
            )
            .join('\n');
        return { stack: resolved, applied };
    }

    private cached(id: string, updatedAt: Date, content: string) {
        const timestamp = updatedAt.getTime();
        const cached = this.cache.get(id);
        if (cached?.updatedAt === timestamp) return cached.map;
        const map = parseSourceMap(content);
        this.cache.set(id, { updatedAt: timestamp, map });
        if (this.cache.size > MAX_SOURCE_MAP_CACHE_ENTRIES) {
            const oldest = this.cache.keys().next().value;
            if (oldest) this.cache.delete(oldest);
        }
        return map;
    }

    private async ensureApp(
        db: Pick<PrismaService, 'rumApp'>,
        organizationId: string,
        projectId: string,
        appId: string,
    ) {
        const app = await db.rumApp.findFirst({
            where: {
                id: appId,
                organizationId,
                projectId,
                deletedAt: null,
            },
            select: { id: true },
        });
        if (!app) throw new NotFoundException('RUM app not found');
        return app;
    }
}

export function normalizeArtifactPath(value: string): string {
    const clean = value.trim().split(/[?#]/, 1)[0];
    try {
        return new URL(clean).pathname;
    } catch {
        return clean.startsWith('/') ? clean : `/${clean}`;
    }
}

const publicSelect = {
    id: true,
    appId: true,
    release: true,
    artifactPath: true,
    checksum: true,
    sizeBytes: true,
    uploadedById: true,
    createdAt: true,
    updatedAt: true,
} as const;
