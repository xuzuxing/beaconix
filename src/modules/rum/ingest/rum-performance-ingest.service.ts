import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../../../generated/prisma/client';
import type { ReportRumPerformanceDto, RumPerformanceSampleDto } from '../dto';
import {
    histogramKey,
    hourBucket,
    ratingFromValue,
} from '../performance/rum-perf-histogram';
import { RumPublicIngestService } from './rum-public-ingest.service';

const STAR = '*';

@Injectable()
export class RumPerformanceIngestService {
    constructor(private readonly publicIngest: RumPublicIngestService) {}

    async report(dto: ReportRumPerformanceDto, source: string) {
        return this.publicIngest.withActiveApp(
            dto.publicKey,
            source,
            async (tx, app) => {
                const now = new Date();
                for (const sample of dto.samples) {
                    const rating =
                        sample.rating ??
                        ratingFromValue(sample.metric, sample.value);
                    await tx.rumPerfSample.create({
                        data: {
                            appId: app.id,
                            metric: sample.metric,
                            value: sample.value,
                            rating,
                            page: sample.page ?? null,
                            release: sample.release ?? null,
                            dimension: sample.dimension ?? null,
                            success: sample.success ?? true,
                            sessionId: sample.sessionId ?? null,
                            endUserId: sample.endUserId ?? null,
                            occurredAt: sample.occurredAt
                                ? new Date(sample.occurredAt)
                                : null,
                            receivedAt: now,
                        },
                    });
                    await this.incrementBucket(tx, app.id, sample, rating, now);
                }
                return { accepted: true, samples: dto.samples.length };
            },
        );
    }

    private async incrementBucket(
        tx: Prisma.TransactionClient,
        appId: string,
        sample: RumPerformanceSampleDto,
        rating: string,
        now: Date,
    ): Promise<void> {
        const bucketStart = hourBucket(now);
        const page = sample.page ?? STAR;
        const dimension = sample.dimension ?? STAR;
        const release = sample.release ?? STAR;
        const histogram = JSON.stringify({
            [histogramKey(sample.metric, sample.value)]: 1,
        });
        const failure = sample.success === false ? 1 : 0;
        const good = rating === 'GOOD' ? 1 : 0;
        const needsImprovement = rating === 'NEEDS_IMPROVEMENT' ? 1 : 0;
        const poor = rating === 'POOR' ? 1 : 0;
        await tx.$executeRaw(
            Prisma.sql`
                INSERT INTO "rum_perf_buckets" (
                    "id", "appId", "metric", "page", "dimension", "release",
                    "bucketStart", "count", "sum", "failureCount",
                    "goodCount", "needsImprovementCount", "poorCount",
                    "histogram", "createdAt", "updatedAt"
                ) VALUES (
                    ${randomUUID()}, ${appId}, ${sample.metric}::"RumPerfMetric",
                    ${page}, ${dimension}, ${release}, ${bucketStart}, 1,
                    ${sample.value}, ${failure}, ${good}, ${needsImprovement},
                    ${poor}, ${histogram}::jsonb, NOW(), NOW()
                )
                ON CONFLICT (
                    "appId", "metric", "page", "dimension", "release",
                    "bucketStart"
                ) DO UPDATE SET
                    "count" = "rum_perf_buckets"."count" + 1,
                    "sum" = "rum_perf_buckets"."sum" + EXCLUDED."sum",
                    "failureCount" =
                        "rum_perf_buckets"."failureCount" + EXCLUDED."failureCount",
                    "goodCount" =
                        "rum_perf_buckets"."goodCount" + EXCLUDED."goodCount",
                    "needsImprovementCount" =
                        "rum_perf_buckets"."needsImprovementCount"
                        + EXCLUDED."needsImprovementCount",
                    "poorCount" =
                        "rum_perf_buckets"."poorCount" + EXCLUDED."poorCount",
                    "histogram" = (
                        SELECT COALESCE(jsonb_object_agg(key, total), '{}'::jsonb)
                        FROM (
                            SELECT key, SUM(value::int) AS total
                            FROM (
                                SELECT * FROM jsonb_each_text(
                                    "rum_perf_buckets"."histogram"
                                )
                                UNION ALL
                                SELECT * FROM jsonb_each_text(
                                    EXCLUDED."histogram"
                                )
                            ) merged
                            GROUP BY key
                        ) aggregated
                    ),
                    "updatedAt" = NOW()
            `,
        );
    }
}
