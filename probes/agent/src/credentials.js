'use strict';

const fs = require('node:fs');

const { BEACON_HOME, CREDENTIALS_PATH, LOG_DIR, RUN_DIR } = require('./paths');

/**
 * Local credential store.
 *
 * The file is written `0640` so the `beacon` service user can read it while
 * other accounts cannot. On non-POSIX filesystems the mode is best-effort.
 */
function ensureStateDirs() {
    for (const dir of [BEACON_HOME, LOG_DIR, RUN_DIR]) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    }
}

function saveCredentials(credentials) {
    ensureStateDirs();
    const payload = `${JSON.stringify(credentials, null, 4)}\n`;
    fs.writeFileSync(CREDENTIALS_PATH, payload, { mode: 0o640 });
    try {
        fs.chmodSync(CREDENTIALS_PATH, 0o640);
    } catch {
        // Non-POSIX filesystems ignore modes.
    }
}

/** Read the stored credentials, or null when the host is not enrolled yet. */
function loadCredentials() {
    let raw;
    try {
        raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw new Error(
            `Cannot read credentials at ${CREDENTIALS_PATH}: ${err.message}`,
        );
    }

    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new Error(
            `Invalid JSON in credentials file ${CREDENTIALS_PATH}: ${err.message}`,
        );
    }
}

function removeCredentials() {
    fs.rmSync(CREDENTIALS_PATH, { force: true });
}

module.exports = {
    ensureStateDirs,
    saveCredentials,
    loadCredentials,
    removeCredentials,
};
