import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service';
import type { ReportRumErrorDto } from '../dto';
import {
    createRumErrorFingerprint,
    RUM_FINGERPRINT_VERSION,
} from '../errors/error-fingerprint';
import { sanitizeRumError } from './ingest-sanitizer';
import { RumRateLimitService } from './rum-rate-limit.service';

@Injectable()
export class RumIngestService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly rateLimit: RumRateLimitService,
    ) {}

    async reportError(dto: ReportRumErrorDto, source: string) {
        const candidate = await this.prisma.rumApp.findUnique({
            where: { publicKey: dto.publicKey },
            select: { id: true, organizationId: true, projectId: true },
        });
        if (!candidate) throw this.unavailable();

        await this.rateLimit.consume(candidate.id, source);

        const error = sanitizeRumError(dto);
        const fingerprint = createRumErrorFingerprint(
            candidate.id,
            error.type,
            error.message,
        );
        const now = new Date();

        await this.prisma.$transaction(async (tx) => {
            // Match the authorization write lock order: organization, project,
            // then the app. Disable/archive waits for an in-flight ingest, and
            // a request starting afterwards observes the new state.
            await tx.$queryRaw`
                SELECT "id" FROM "organizations"
                WHERE "id" = ${candidate.organizationId} FOR SHARE
            `;
            await tx.$queryRaw`
                SELECT "id" FROM "projects"
                WHERE "id" = ${candidate.projectId} FOR SHARE
            `;
            await tx.$queryRaw`
                SELECT "id" FROM "rum_apps"
                WHERE "id" = ${candidate.id} FOR SHARE
            `;

            const app = await tx.rumApp.findFirst({
                where: {
                    id: candidate.id,
                    organizationId: candidate.organizationId,
                    projectId: candidate.projectId,
                    enabled: true,
                    deletedAt: null,
                    organization: { deletedAt: null },
                    project: { deletedAt: null, status: 'ACTIVE' },
                },
                select: { id: true },
            });
            if (!app) throw this.unavailable();

            await tx.rumErrorGroup.upsert({
                where: {
                    appId_fingerprintVersion_fingerprint: {
                        appId: app.id,
                        fingerprintVersion: RUM_FINGERPRINT_VERSION,
                        fingerprint,
                    },
                },
                create: {
                    appId: app.id,
                    fingerprint,
                    fingerprintVersion: RUM_FINGERPRINT_VERSION,
                    type: error.type,
                    message: error.message,
                    stack: error.stack,
                    page: error.page,
                    firstSeenAt: now,
                    lastSeenAt: now,
                    firstOccurredAt: error.occurredAt,
                    lastOccurredAt: error.occurredAt,
                },
                update: {
                    count: { increment: 1 },
                    lastSeenAt: now,
                    ...(error.stack ? { stack: error.stack } : {}),
                    ...(error.page ? { page: error.page } : {}),
                    ...(error.occurredAt
                        ? { lastOccurredAt: error.occurredAt }
                        : {}),
                },
            });
        });

        return { accepted: true };
    }

    private unavailable(): NotFoundException {
        return new NotFoundException('RUM app unavailable');
    }
}
