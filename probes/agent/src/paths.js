'use strict';

const os = require('node:os');
const path = require('node:path');

/**
 * Filesystem layout of the agent.
 *
 * On Linux the agent runs as the dedicated `beaconix` system user and keeps its
 * state under /etc, /var/log and /run. `BEACON_HOME`, `BEACON_CREDENTIALS`,
 * `BEACON_LOG_DIR` and `BEACON_RUN_DIR` override these so tests and local runs
 * stay out of system directories.
 */
function defaultHome() {
    if (process.platform === 'linux') return '/etc/beaconix';
    if (process.platform === 'darwin') return '/usr/local/etc/beaconix';
    return path.join(os.homedir(), '.beaconix');
}

function defaultLogDir() {
    if (process.platform === 'linux') return '/var/log/beaconix';
    if (process.platform === 'darwin') return '/usr/local/var/log/beaconix';
    return path.join(os.homedir(), '.beaconix', 'logs');
}

function defaultRunDir() {
    if (process.platform === 'linux') return '/run/beaconix';
    if (process.platform === 'darwin') return '/usr/local/var/run/beaconix';
    return path.join(os.homedir(), '.beaconix', 'run');
}

const BEACON_HOME = process.env.BEACON_HOME || defaultHome();
const CREDENTIALS_PATH =
    process.env.BEACON_CREDENTIALS || path.join(BEACON_HOME, 'probe.json');
const LOG_DIR = process.env.BEACON_LOG_DIR || defaultLogDir();
const RUN_DIR = process.env.BEACON_RUN_DIR || defaultRunDir();
const PID_FILE = path.join(RUN_DIR, 'probe.pid');
const LOG_FILE = path.join(LOG_DIR, 'probe.log');

/** systemd unit / launchd label name. */
const SERVICE_NAME = 'beaconix-probe';

module.exports = {
    BEACON_HOME,
    CREDENTIALS_PATH,
    LOG_DIR,
    RUN_DIR,
    PID_FILE,
    LOG_FILE,
    SERVICE_NAME,
};
