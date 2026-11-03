import type { Prisma } from '../../../generated/prisma/client';
import type { RumMetricKind } from '../../../generated/prisma/enums';

export function minuteBucket(value: Date): Date {
    const bucket = new Date(value);
    bucket.setUTCSeconds(0, 0);
    return bucket;
}

export async function incrementRumMetric(
    tx: Prisma.TransactionClient,
    appId: string,
    kind: RumMetricKind,
    name: string,
    at: Date,
): Promise<void> {
    const bucketStart = minuteBucket(at);
    await tx.rumMetricBucket.upsert({
        where: {
            appId_kind_name_bucketStart: {
                appId,
                kind,
                name,
                bucketStart,
            },
        },
        create: { appId, kind, name, bucketStart, count: 1 },
        update: { count: { increment: 1 } },
    });
}
