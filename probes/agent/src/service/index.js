'use strict';

const systemd = require('./systemd');
const launchd = require('./launchd');
const pidfile = require('./pidfile');

/**
 * The init-system integration available on this host, or null when neither
 * systemd (Linux) nor launchd (macOS) applies.
 */
function initBackend() {
    if (process.platform === 'linux') return systemd;
    if (process.platform === 'darwin') return launchd;
    return null;
}

/**
 * Build the environment a background `run` process should inherit so it
 * behaves exactly like a foreground run (CLI flags would otherwise be lost).
 */
function backgroundEnv(config) {
    return {
        ...process.env,
        BEACON_API_URL: config.apiUrl,
        PROBE_KEY: config.key,
        PROBE_TOKEN: config.token,
        PROBE_INTERVAL_SECONDS: String(config.intervalSeconds),
        PROBE_TIMEOUT_MS: String(config.timeoutMs),
        PROBE_MAX_RESULTS: String(config.maxResultsPerReport),
        PROBE_ALLOW_INSECURE: config.allowInsecure ? 'true' : 'false',
    };
}

module.exports = { initBackend, pidfile, systemd, launchd, backgroundEnv };
