'use strict';

const { initBackend, pidfile } = require('../service');
const { loadCredentials } = require('../credentials');
const { CREDENTIALS_PATH } = require('../paths');

/** `beaconix-probe status` — credentials + service + background process. */
async function runStatus() {
    const backend = initBackend();
    const serviceInstalled = Boolean(backend && backend.isInstalled());
    const pidState = pidfile.status();
    const stored = loadCredentials();

    console.log('Beacon probe status');
    console.log(
        `  credentials:  ${stored ? CREDENTIALS_PATH : 'not enrolled'}`,
    );
    if (stored) {
        console.log(`  probe id:     ${stored.key}`);
        console.log(`  api url:      ${stored.apiUrl}`);
    }
    console.log(
        `  service unit: ${serviceInstalled ? 'installed' : 'not installed'}`,
    );
    console.log(
        `  background:   ${pidState.running ? `running (pid ${pidState.pid})` : 'not running'}`,
    );

    return {
        ok: true,
        enrolled: Boolean(stored),
        probeId: stored ? stored.key : null,
        serviceInstalled,
        running: pidState.running,
        pid: pidState.pid,
    };
}

module.exports = { runStatus };
