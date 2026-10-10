'use strict';

const { revokeProbe } = require('../api');
const { loadCredentials, removeCredentials } = require('../credentials');
const { CREDENTIALS_PATH } = require('../paths');
const logger = require('../logger');

/**
 * `beacon-probe logout [--revoke]` — drop the stored credentials, optionally
 * telling the backend to revoke the probe first.
 */
async function runLogout(config, args) {
    const stored = loadCredentials();
    if (!stored) {
        logger.log(`Not enrolled: no credentials at ${CREDENTIALS_PATH}`);
        return { ok: true, removed: false };
    }

    if (args.revoke) {
        try {
            await revokeProbe({
                ...config,
                apiUrl: stored.apiUrl || config.apiUrl,
                token: stored.token || config.token,
            });
            logger.log('Probe revoked on the backend');
        } catch (err) {
            logger.warn(
                `Backend revoke failed (removing local credentials anyway): ${err.message}`,
            );
        }
    }

    removeCredentials();
    logger.log(`Credentials removed from ${CREDENTIALS_PATH}`);
    return { ok: true, removed: true };
}

module.exports = { runLogout };
