'use strict';

/**
 * Tencent SCF (云函数) entry point.
 *
 * Cloud functions are event-driven and short-lived, so the agent runs exactly
 * one cycle per invocation — there is no long-lived schedule to keep. Point a
 * timer trigger at `main_handler` and set the trigger period equal to
 * PROBE_INTERVAL_SECONDS: each run reports a heartbeat and checks every monitor
 * assigned to this probe.
 *
 * Required environment variables (configure in the SCF console):
 *   BEACON_API_URL       Beacon API base URL (must be https)
 *   PROBE_KEY            Probe id
 *   PROBE_TOKEN          Probe secret
 *   PROBE_INTERVAL_SECONDS  MUST equal the timer trigger period, otherwise the
 *                           backend's offline threshold will not match the
 *                           cadence this probe actually calls in with.
 *
 * Optional: PROBE_SCF_MODE (run|validate), PROBE_TIMEOUT_MS, PROBE_MAX_RESULTS,
 *           PROBE_CONCURRENCY, PROBE_ALLOW_INSECURE.
 *
 * SCF console handler: `scf.main_handler`
 */

const { parseArgs, loadConfig } = require('../src/config');
const { createSchedule } = require('../src/schedule');
const { runCycle } = require('../src/commands/run');
const { runValidate } = require('../src/commands/validate');

function describe(err) {
    return err && err.message ? err.message : String(err);
}

/**
 * One invocation = one cycle: answer a pending validation challenge (if any),
 * heartbeat, run every assigned check, report the results.
 *
 * Never throws: a failure is returned as `{ code: 1, error }` so the trigger
 * records a failed run instead of an unhandled rejection.
 */
exports.main_handler = async () => {
    const mode = process.env.PROBE_SCF_MODE || 'run';

    try {
        const config = loadConfig(parseArgs([]));
        const result =
            mode === 'validate'
                ? await runValidate(config)
                : await runCycle(config, createSchedule());

        return { code: 0, mode, result };
    } catch (err) {
        console.error(describe(err));
        return { code: 1, mode, error: describe(err) };
    }
};

// Local testing: `node probes/agent/functions/scf.js`
if (require.main === module) {
    exports
        .main_handler({}, {})
        .then((result) => {
            console.log(JSON.stringify(result));
            process.exitCode = result.code === 0 ? 0 : 1;
        })
        .catch((err) => {
            console.error(describe(err));
            process.exitCode = 1;
        });
}
