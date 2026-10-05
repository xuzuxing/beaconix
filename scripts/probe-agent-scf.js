#!/usr/bin/env node
'use strict';

/**
 * Tencent SCF (云函数) entry for the Beacon probe agent.
 *
 * Deploy this file together with `probe-agent.js`. SCF invokes
 * `main_handler` on each trigger (typically a timer trigger); every
 * invocation runs exactly one cycle:
 *
 *   answer pending validation challenge (if any)
 *     -> heartbeat -> fetch monitors -> execute checks -> report results
 *
 * Required environment variables (configure in the SCF console):
 *   BEACON_API_URL      Beacon API base URL (must be https)
 *   PROBE_KEY           Probe id (the "key")
 *   PROBE_TOKEN         Probe secret (the "token"; PROBE_SECRET also works)
 *
 * Optional:
 *   PROBE_SCF_MODE      `run` (default) or `validate`
 *   PROBE_TIMEOUT_MS    Per-request/check timeout (default 5000)
 *   PROBE_MAX_RESULTS   Max results per report (default 100)
 *   PROBE_ALLOW_INSECURE  Set to `true` only for testing with http://
 *
 * SCF console handler:  probe-agent-scf.main_handler
 */

const { loadConfig, parseArgs, runCycle, runValidate } = require('./probe-agent');

/**
 * Tencent SCF Node.js entrypoint.
 *
 * @param {object} event SCF trigger event (timer/API Gateway/etc.)
 * @param {object} context SCF runtime context
 * @returns {Promise<{ code: number, mode: string, error?: string, result?: object }>}
 */
exports.main_handler = async (event, context) => {
    const mode = process.env.PROBE_SCF_MODE || 'run';

    try {
        const config = loadConfig(parseArgs([]));
        const result =
            mode === 'validate'
                ? await runValidate(config)
                : await runCycle(config);

        return { code: 0, mode, result };
    } catch (err) {
        console.error(err.message);
        return { code: 1, mode, error: err.message };
    }
};

// Allow local testing: `node scripts/probe-agent-scf.js`
if (require.main === module) {
    exports
        .main_handler({}, {})
        .then((result) => {
            console.log(JSON.stringify(result));
            process.exitCode = result.code === 0 ? 0 : 1;
        })
        .catch((err) => {
            console.error(err.message);
            process.exitCode = 1;
        });
}
