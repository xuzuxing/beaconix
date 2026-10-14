'use strict';

const { initBackend, pidfile, backgroundEnv } = require('../service');
const { runLoop } = require('./run');
const { assertCredentials } = require('../preflight');
const { SERVICE_NAME } = require('../paths');
const logger = require('../logger');

/**
 * `beaconix-probe start [--foreground]` — prefer the init-system unit when it is
 * installed, otherwise fall back to a pidfile-managed background process.
 */
async function runStart(config, args) {
    assertCredentials(config);

    if (args.foreground) {
        await runLoop(config);
        return { ok: true, mode: 'foreground' };
    }

    const backend = initBackend();
    if (backend && backend.isInstalled()) {
        const result = await backend.action('start');
        if (result.ok) {
            logger.log(
                `Service ${SERVICE_NAME} started (system service manager)`,
            );
            return { ok: true, mode: 'service' };
        }
        logger.warn(
            `Service manager start failed${result.error ? `: ${result.error}` : ''}; ` +
                'falling back to a background process',
        );
    }

    const result = pidfile.start(backgroundEnv(config));
    if (result.already) {
        logger.log(
            `Probe already running in the background (pid ${result.pid})`,
        );
    } else {
        logger.log(`Probe started in the background (pid ${result.pid})`);
    }
    return { ok: true, mode: 'pidfile', pid: result.pid };
}

module.exports = { runStart };
