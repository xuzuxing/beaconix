import type { Prisma } from '../../generated/prisma/client';
import { createHash } from 'node:crypto';

export function capacityStateKey(cycle: {
    status: string;
    toPlanId: string;
    limit: number;
    retainedMonitorIds: string[];
    restrictedMonitorIds: string[];
}) {
    return createHash('sha256')
        .update(
            JSON.stringify([
                cycle.status,
                cycle.toPlanId,
                cycle.limit,
                cycle.retainedMonitorIds.slice().sort(),
                cycle.restrictedMonitorIds.slice().sort(),
            ]),
        )
        .digest('hex');
}

/** Capacity transitions take org before monitor; observation writers agree. */
export async function lockObservationMonitor(
    tx: Prisma.TransactionClient,
    monitorId: string,
) {
    await tx.$queryRaw`SELECT id FROM organizations WHERE id = (SELECT "organizationId" FROM monitors WHERE id = ${monitorId}) FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM monitors WHERE id = ${monitorId} FOR UPDATE`;
}

/** A quota exclusion never changes the user's enabled flag. */
export function capacityRestricted(
    monitor: { quotaGraceEndsAt?: Date | null },
    at = new Date(),
): boolean {
    return !!monitor.quotaGraceEndsAt && monitor.quotaGraceEndsAt <= at;
}

export const MONITOR_CAPACITY_REASON = 'MONITOR_QUOTA_EXCEEDED';
export const CAPACITY_GRACE_MS = 72 * 60 * 60 * 1000;

/** Explicit choices first; fill free slots using the caller's stable ordering. */
export function retainedMonitorIds(
    monitors: { id: string }[],
    selected: string[],
    limit: number,
): string[] {
    const live = new Set(monitors.map(({ id }) => id));
    return [
        ...new Set([...selected.filter((id) => live.has(id)), ...live]),
    ].slice(0, Math.max(0, limit));
}
