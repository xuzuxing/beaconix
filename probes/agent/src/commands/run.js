'use strict';

const { createSchedule, resolveConcurrency } = require('../schedule');
const { heartbeat } = require('../api');
const { pollAndAnswerValidation } = require('../validation');
const { ensureEnrolled } = require('../enroll');
const { assertCredentials, assertEncryptedTransport } = require('../preflight');
const { sleep } = require('../util');
const logger = require('../logger');

function createShutdownSignal() {
    const controller = new AbortController();

    const shutdown = () => {
        logger.log('Shutdown signal received, stopping...');
        controller.abort();
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    return controller.signal;
}

/**
 * One round: answer a pending validation challenge, heartbeat (which also pulls
 * the assigned monitors), run every due check, then report the buffered
 * results. Throws only when an unrecoverable step failed.
 */
async function runCycle(config, schedule) {
    assertCredentials(config);
    assertEncryptedTransport(config);

    let roundError = null;
    let probeId = 'unknown';
    let status = 'unknown';
    let assigned = 0;

    try {
        await pollAndAnswerValidation(config);

        const data = await heartbeat(config);
        const monitors = Array.isArray(data && data.monitors)
            ? data.monitors
            : [];
        probeId = data && data.probe ? data.probe.id : 'unknown';
        status = data && data.probe ? data.probe.status : 'unknown';
        assigned = monitors.length;

        const stats = schedule.sync(monitors);

        logger.log(
            `Heartbeat OK: probe=${probeId} status=${status} monitors=${assigned} ` +
                `(tracked=${stats.tracked} added=${stats.added} ` +
                `rescheduled=${stats.rescheduled} removed=${stats.removed})`,
        );
    } catch (err) {
        // A missed heartbeat must not stop local checks: the schedule keeps
        // running on its own intervals and results stay buffered until the
        // backend is reachable again.
        roundError = err;
        logger.warn(
            `Heartbeat failed, keeping the local schedule ` +
                `(${schedule.size()} monitor(s)): ${err.message}`,
        );
    }

    const outcome = await schedule.runDue(config);

    if (outcome.executed > 0) {
        logger.log(`Checked ${outcome.executed}/${outcome.due} due monitor(s)`);
    }

    let reported = 0;
    try {
        reported = await schedule.flush(config);
        if (reported > 0) logger.log(`Reported ${reported} result(s)`);
    } catch (err) {
        logger.warn(
            `Reporting failed, keeping ${schedule.buffered()} result(s) buffered: ${err.message}`,
        );
        if (!roundError) roundError = err;
    }

    if (roundError) throw roundError;

    return {
        probeId,
        monitors: assigned,
        checked: outcome.executed,
        reported,
    };
}

async function runLoop(config) {
    // A fresh host has no credential yet: run the device authorization first so
    // the operator sees the approval URL instead of a hard failure.
    const enrolled = await ensureEnrolled(config);
    const activeConfig = enrolled ? { ...config, ...enrolled } : config;
    assertCredentials(activeConfig);

    const signal = createShutdownSignal();
    const schedule = createSchedule();
    let consecutiveFailures = 0;

    logger.log(
        `Probe agent started: probe=${activeConfig.key} heartbeat=${activeConfig.intervalSeconds}s ` +
            `concurrency=${resolveConcurrency()} (checks follow each monitor's interval)`,
    );

    while (!signal.aborted) {
        try {
            await runCycle(activeConfig, schedule);
            consecutiveFailures = 0;
        } catch (err) {
            consecutiveFailures += 1;
            logger.warn(
                `Cycle failed (${consecutiveFailures} consecutive): ${err.message}`,
            );
        }

        if (signal.aborted) break;

        let delayMs = activeConfig.intervalSeconds * 1000;
        if (consecutiveFailures > 0) {
            // Retry sooner after failures so a transient network blip recovers
            // quickly, but never wait longer than the configured interval.
            delayMs = Math.min(
                delayMs,
                1000 * 2 ** Math.min(consecutiveFailures - 1, 6),
            );
        }
        delayMs = Math.max(1000, delayMs);
        await sleep(delayMs, signal);
    }

    logger.log('Probe agent stopped');
}

module.exports = { runCycle, runLoop, createShutdownSignal };
