import { Injectable } from '@nestjs/common';
import { RumMetricKind } from '../../../generated/prisma/enums';
import type { ReportRumErrorDto } from '../dto';
import {
    createRumErrorFingerprint,
    RUM_FINGERPRINT_VERSION,
} from '../errors/error-fingerprint';
import { sanitizeRumError } from './ingest-sanitizer';
import { RumPublicIngestService } from './rum-public-ingest.service';
import { incrementRumMetric } from '../metrics/rum-metric-bucket';
import { RumSourceMapsService } from '../source-maps/rum-source-maps.service';

@Injectable()
export class RumIngestService {
    constructor(
        private readonly publicIngest: RumPublicIngestService,
        private readonly sourceMaps: RumSourceMapsService,
    ) {}

    async reportError(dto: ReportRumErrorDto, source: string) {
        const error = sanitizeRumError(dto);
        return this.publicIngest.withActiveApp(
            dto.publicKey,
            source,
            async (tx, app) => {
                const fingerprint = createRumErrorFingerprint(
                    app.id,
                    error.type,
                    error.message,
                );
                const now = new Date();
                const release = dto.release?.trim() || null;
                const resolved = await this.sourceMaps.symbolicate(
                    app.id,
                    release,
                    error.stack,
                    tx,
                );
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
                        resolvedStack: resolved.applied ? resolved.stack : null,
                        page: error.page,
                        release,
                        replaySessionId: dto.sessionId?.trim() || null,
                        sourceMapApplied: resolved.applied,
                        firstSeenAt: now,
                        lastSeenAt: now,
                        firstOccurredAt: error.occurredAt,
                        lastOccurredAt: error.occurredAt,
                    },
                    update: {
                        count: { increment: 1 },
                        lastSeenAt: now,
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
                        release,
                        replaySessionId: dto.sessionId?.trim() || null,
                        ...(error.occurredAt
                            ? { lastOccurredAt: error.occurredAt }
                            : {}),
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
