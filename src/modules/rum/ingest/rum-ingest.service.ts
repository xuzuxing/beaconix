import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { RumMetricKind } from '../../../generated/prisma/enums';
import type { ReportRumErrorDto } from '../dto';
import {
    createRumErrorFingerprint,
    RUM_FINGERPRINT_VERSION,
} from '../errors/error-fingerprint';
import { rumErrorContextSize, sanitizeRumError } from './ingest-sanitizer';
import { RumPublicIngestService } from './rum-public-ingest.service';
import { incrementRumMetric } from '../metrics/rum-metric-bucket';
import { RumSourceMapsService } from '../source-maps/rum-source-maps.service';

const MAX_ERROR_CONTEXT_BYTES = 48 * 1024;

@Injectable()
export class RumIngestService {
    constructor(
        private readonly publicIngest: RumPublicIngestService,
        private readonly sourceMaps: RumSourceMapsService,
    ) {}

    async reportError(dto: ReportRumErrorDto, source: string) {
        const error = sanitizeRumError(dto);
        if (rumErrorContextSize(error) > MAX_ERROR_CONTEXT_BYTES) {
            throw new BadRequestException(
                `RUM error context exceeds ${MAX_ERROR_CONTEXT_BYTES} bytes`,
            );
        }
        return this.publicIngest.withActiveApp(
            dto.publicKey,
            source,
            async (tx, app) => {
                if (error.clientEventId) {
                    await tx.$executeRaw`
                        SELECT pg_advisory_xact_lock(
                            hashtext(${app.id}),
                            hashtext(${error.clientEventId})
                        )
                    `;
                    const existing = await tx.rumErrorOccurrence.findUnique({
                        where: {
                            appId_clientEventId: {
                                appId: app.id,
                                clientEventId: error.clientEventId,
                            },
                        },
                        select: { id: true },
                    });
                    if (existing) return { accepted: true };
                }
                const fingerprint = createRumErrorFingerprint(app.id, error);
                const now = new Date();
                const resolved = await this.sourceMaps.symbolicate(
                    app.id,
                    error.release,
                    error.stack,
                    tx,
                );
                const group = await tx.rumErrorGroup.upsert({
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
                        category: error.category,
                        level: error.level,
                        message: error.message,
                        stack: error.stack,
                        resolvedStack: resolved.applied ? resolved.stack : null,
                        page: error.page,
                        release: error.release,
                        replaySessionId: error.sessionId,
                        sourceMapApplied: resolved.applied,
                        firstSeenAt: now,
                        lastSeenAt: now,
                        firstOccurredAt: error.occurredAt,
                        lastOccurredAt: error.occurredAt,
                    },
                    update: {
                        count: { increment: 1 },
                        lastSeenAt: now,
                        category: error.category,
                        level: error.level,
                        ...(error.stack
                            ? {
                                  stack: error.stack,
                                  resolvedStack: resolved.applied
                                      ? resolved.stack
                                      : null,
                                  sourceMapApplied: resolved.applied,
                              }
                            : {}),
                        ...(error.page ? { page: error.page } : {}),
                        release: error.release,
                        replaySessionId: error.sessionId,
                        ...(error.occurredAt
                            ? { lastOccurredAt: error.occurredAt }
                            : {}),
                    },
                    select: { id: true },
                });
                await tx.rumErrorOccurrence.create({
                    data: {
                        appId: app.id,
                        groupId: group.id,
                        clientEventId: error.clientEventId,
                        category: error.category,
                        level: error.level,
                        type: error.type,
                        message: error.message,
                        stack: error.stack,
                        resolvedStack: resolved.applied ? resolved.stack : null,
                        sourceMapApplied: resolved.applied,
                        page: error.page,
                        release: error.release,
                        sessionId: error.sessionId,
                        endUserId: error.endUserId,
                        anonymousId: error.anonymousId,
                        requestId: error.requestId,
                        http: jsonValue(error.http),
                        resource: jsonValue(error.resource),
                        vue: jsonValue(error.vue),
                        breadcrumbs: error.breadcrumbs as Prisma.InputJsonValue,
                        sdk: jsonValue(error.sdk),
                        occurredAt: error.occurredAt,
                        receivedAt: now,
                    },
                });
                await incrementRumMetric(
                    tx,
                    app.id,
                    RumMetricKind.ERROR,
                    '*',
                    now,
                );
                return { accepted: true };
            },
        );
    }
}

function jsonValue(
    value: Record<string, unknown> | null,
): Prisma.InputJsonValue | undefined {
    return value ? (value as Prisma.InputJsonValue) : undefined;
}
