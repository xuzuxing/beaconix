'use strict';

const { initBackend, pidfile, backgroundEnv } = require('../service');
const { runLoop } = require('./run');
const { loadCredentials } = require('../credentials');
const { SERVICE_NAME, LOG_FILE } = require('../paths');
const logger = require('../logger');

/** Credentials may come from flags/env or from a previous login/enroll. */
function hasCredentials(config) {
    if (config.key && config.token) return true;
    const stored = loadCredentials();
    return Boolean(stored && stored.key && stored.token);
}

/**
 * `beaconix-probe start [--foreground]` — prefer the init-system unit when it is
 * installed, otherwise fall back to a pidfile-managed background process.
 *
 * Credentials are no longer required here: a fresh host's first `run` prints the
 * device-authorization URL and enrolls itself, so `start` only has to point the
 * operator at the log that will carry that URL.
 */
async function runStart(config, args) {
    const enrolled = hasCredentials(config);
    if (!enrolled) {
        logger.log(
            'No probe credential yet; the agent will print a device authorization URL on startup',
        );
    }

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
            if (!enrolled) {
                logger.log(
                    `Authorization URL: journalctl -u ${SERVICE_NAME} -f`,
                );
            }
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
    if (!enrolled) {
        logger.log(`Authorization URL: tail -f ${LOG_FILE}`);
    }
    return { ok: true, mode: 'pidfile', pid: result.pid };
}

module.exports = { runStart };
