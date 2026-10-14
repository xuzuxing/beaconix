'use strict';

const { initBackend } = require('../service');
const { SERVICE_NAME } = require('../paths');
const logger = require('../logger');
const { runStop } = require('./stop');
const { runStart } = require('./start');

/** `beaconix-probe restart` — restart the unit if installed, else background. */
async function runRestart(config, args) {
    const backend = initBackend();
    if (backend && backend.isInstalled()) {
        const result = await backend.action('restart');
        if (result.ok) {
            logger.log(`Service ${SERVICE_NAME} restarted`);
            return { ok: true, mode: 'service' };
        }
        logger.warn(
            `Service manager restart failed${result.error ? `: ${result.error}` : ''}; ` +
                'falling back to a background process',
        );
    }

    await runStop();
    return runStart(config, args);
}

module.exports = { runRestart };
