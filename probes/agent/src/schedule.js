'use strict';

const { performance } = require('node:perf_hooks');

const {
    DEFAULT_CONCURRENCY,
    DEFAULT_INTERVAL_SECONDS,
    MAX_CONCURRENCY,
    MAX_PENDING_RESULTS,
    MIN_CHECK_INTERVAL_SECONDS,
} = require('./constants');
const { checkMonitor } = require('./checks');
const { reportResults } = require('./api');
const logger = require('./logger');

/**
 * Parallel checks per round. Cloud functions run everything they are assigned
 * in one invocation, so a probe with many monitors needs a higher value (and a
 * matching function timeout); override with PROBE_CONCURRENCY.
 */
function resolveConcurrency() {
    const raw = Number(process.env.PROBE_CONCURRENCY);
    if (!Number.isInteger(raw) || raw < 1) return DEFAULT_CONCURRENCY;
    return Math.min(raw, MAX_CONCURRENCY);
}

/**
 * Monotonic clock: the schedule must not jump when the system clock is
 * adjusted (NTP steps, DST, manual changes).
 */
function nowMs() {
    return performance.now();
}

function monitorSignature(monitor) {
    return [
        monitor.type,
        monitor.target,
        monitor.interval,
        monitor.timeout,
        monitor.expectedStatus,
    ].join('|');
}

function monitorIntervalMs(monitor) {
    const seconds = Number(monitor && monitor.interval);
    const safe =
        Number.isFinite(seconds) && seconds > 0
            ? seconds
            : DEFAULT_INTERVAL_SECONDS;

    return Math.max(MIN_CHECK_INTERVAL_SECONDS, safe) * 1000;
}

/**
 * Local check schedule driven by the monitors the backend hands back.
 *
 * The heartbeat response is the authoritative task list, but it is *not* a
 * "check everything now" command: each monitor is checked on its own
 * `interval`, at most `DEFAULT_CONCURRENCY` checks at a time.
 *
 * Results are buffered and reported once per round; while the backend is
 * unreachable the buffer is kept (up to MAX_PENDING_RESULTS) so a short outage
 * does not lose data, and checks pause once it is full.
 */
function createSchedule() {
    /** @type {Map<string, {monitor: object, signature: string, nextDueAt: number, inFlight: boolean}>} */
    const tasks = new Map();
    /** @type {Array<object>} */
    let pending = [];

    function sync(monitors, at = nowMs()) {
        const seen = new Set();
        let added = 0;
        let rescheduled = 0;

        for (const monitor of monitors) {
            if (!monitor || typeof monitor.id !== 'string') continue;

            const signature = monitorSignature(monitor);
            const existing = tasks.get(monitor.id);
            seen.add(monitor.id);

            if (!existing) {
                // New assignment: check it right away to get a first result.
                tasks.set(monitor.id, {
                    monitor,
                    signature,
                    nextDueAt: at,
                    inFlight: false,
                });
                added += 1;
                continue;
            }

            existing.monitor = monitor;

            if (existing.signature !== signature) {
                // Target/interval/timeout changed - re-check immediately so the
                // new definition takes effect instead of waiting out the old one.
                existing.signature = signature;
                existing.nextDueAt = at;
                rescheduled += 1;
            }
        }

        let removed = 0;
        for (const id of [...tasks.keys()]) {
            if (!seen.has(id)) {
                tasks.delete(id);
                removed += 1;
            }
        }

        return { tracked: tasks.size, added, rescheduled, removed };
    }

    function dueTasks(at) {
        const due = [];
        for (const task of tasks.values()) {
            if (!task.inFlight && task.nextDueAt <= at) due.push(task);
        }
        return due;
    }

    async function runDue(config) {
        const due = dueTasks(nowMs());
        if (due.length === 0) return { due: 0, executed: 0, deferred: 0 };

        if (pending.length >= MAX_PENDING_RESULTS) {
            logger.warn(
                `Result buffer is full (${pending.length}/${MAX_PENDING_RESULTS}); ` +
                    `pausing checks until it can be reported`,
            );
            return { due: due.length, executed: 0, deferred: due.length };
        }

        let executed = 0;
        let active = 0;
        let cursor = 0;
        const workerCount = Math.min(resolveConcurrency(), due.length);

        const workers = Array.from({ length: workerCount }, async () => {
            while (
                cursor < due.length &&
                pending.length + active < MAX_PENDING_RESULTS
            ) {
                const task = due[cursor];
                cursor += 1;

                if (task.inFlight) continue;
                task.inFlight = true;
                active += 1;

                try {
                    const result = await checkMonitor(task.monitor, config);
                    pending.push(result);
                    executed += 1;

                    const state = result.success ? 'UP' : 'DOWN';
                    const latency =
                        result.latency !== null ? ` (${result.latency}ms)` : '';
                    const detail = result.error ? ` - ${result.error}` : '';
                    logger.log(
                        `  ${task.monitor.type} ${result.target}: ${state}${latency}${detail}`,
                    );
                } catch (err) {
                    // checkMonitor reports target failures as results; throwing
                    // here means a bug, so keep it out of the report.
                    logger.warn(
                        `Check failed for monitor ${task.monitor.id}: ${err.message}`,
                    );
                } finally {
                    active -= 1;
                    task.inFlight = false;
                    task.nextDueAt = nowMs() + monitorIntervalMs(task.monitor);
                }
            }
        });

        await Promise.all(workers);

        return {
            due: due.length,
            executed,
            deferred: due.length - executed,
        };
    }

    async function flush(config) {
        if (pending.length === 0) return 0;

        const batch = pending;
        pending = [];

        try {
            await reportResults(config, batch);
            return batch.length;
        } catch (err) {
            // Keep the results for the next round rather than dropping them.
            pending = batch.concat(pending);
            throw err;
        }
    }

    return {
        sync,
        runDue,
        flush,
        buffered: () => pending.length,
        size: () => tasks.size,
    };
}

module.exports = {
    createSchedule,
    monitorSignature,
    monitorIntervalMs,
    resolveConcurrency,
    nowMs,
};
