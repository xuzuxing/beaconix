/** No-data is an execution gap, independent of reachability failures. */
export const NO_DATA_REASON = 'NO_DATA';

export function noDataTimeoutMs(interval: number): number {
    return Math.max(3 * interval * 1000, 10 * 60 * 1000);
}

export function observationIsFresh(
    interval: number,
    checkedAt: Date,
    now = new Date(),
): boolean {
    return (
        checkedAt <= now &&
        now.getTime() - checkedAt.getTime() < noDataTimeoutMs(interval)
    );
}

/** Editing/re-enabling a monitor grants a new scheduling grace period. */
export function observationAnchor(monitor: {
    createdAt: Date;
    updatedAt: Date;
    state?: { lastEffectiveObservationAt?: Date | null } | null;
}): Date {
    return new Date(
        Math.max(
            monitor.createdAt.getTime(),
            monitor.updatedAt.getTime(),
            monitor.state?.lastEffectiveObservationAt?.getTime() ?? 0,
        ),
    );
}
