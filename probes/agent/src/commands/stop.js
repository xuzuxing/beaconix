'use strict';

const { initBackend, pidfile } = require('../service');
const { SERVICE_NAME } = require('../paths');
const logger = require('../logger');

/** `beaconix-probe stop` — stop the unit if installed, else the pidfile process. */
async function runStop() {
    const backend = initBackend();
    if (backend && backend.isInstalled()) {
        const result = await backend.action('stop');
        if (result.ok) {
            logger.log(`Service ${SERVICE_NAME} stopped`);
            return { ok: true, mode: 'service' };
        }
        logger.warn(
            `Service manager stop failed${result.error ? `: ${result.error}` : ''}; ` +
                'falling back to the pidfile process',
        );
    }

    const result = pidfile.stop();
    if (result.stopped) {
        logger.log(`Probe stopped (pid ${result.pid})`);
    } else {
        logger.log('Probe is not running');
    }
    return { ok: true, mode: 'pidfile', stopped: result.stopped };
}

module.exports = { runStop };
