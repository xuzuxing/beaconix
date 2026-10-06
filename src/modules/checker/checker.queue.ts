/** Queue that owns the tick: it only looks up due monitors and fans out work. */
export const MONITOR_SCAN_QUEUE = 'monitor-scans';

/** Job produced on every tick by the job scheduler below. */
export const MONITOR_SCAN_JOB = 'monitor-scan';

/** Id of the BullMQ job scheduler that drives the scan tick. */
export const MONITOR_SCAN_SCHEDULER_ID = 'monitor-checker';

/** How often due monitors are looked up, in milliseconds. */
export const MONITOR_SCAN_INTERVAL_MS = 10_000;

/** Queue that runs the actual local checks, one job per monitor. */
export const MONITOR_CHECK_QUEUE = 'monitor-checks';

/** Job that runs the local check of a single monitor. */
export const MONITOR_CHECK_JOB = 'monitor-check';

/** How many monitors one worker checks in parallel. */
export const MONITOR_CHECK_CONCURRENCY = 5;

/**
 * Prefix of the deduplication id used for per-monitor check jobs. While a
 * monitor's job is still waiting or active a new one is dropped, so a slow
 * target cannot pile up overlapping checks; BullMQ releases the key once the
 * job finalizes (and recovers it after a crash), so the next tick can enqueue
 * the monitor again.
 */
export const MONITOR_CHECK_DEDUP_PREFIX = 'monitor-check';

export interface MonitorCheckJobData {
    monitorId: string;
}
