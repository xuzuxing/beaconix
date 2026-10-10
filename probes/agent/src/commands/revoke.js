'use strict';

const { revokeProbe } = require('../api');
const { loadCredentials } = require('../credentials');
const { CREDENTIALS_PATH } = require('../paths');
const { assertCredentials, assertEncryptedTransport } = require('../preflight');
const logger = require('../logger');

/**
 * `beacon-probe revoke` — revoke this probe's credential on the backend but
 * keep the local copy, so an operator can confirm the host is cut off before
 * deciding what to do with the file. Use `logout --revoke` to revoke *and*
 * remove the local credential in one step.
 */
async function runRevoke(config) {
    const stored = loadCredentials();
    if (!stored) {
        throw new Error(`Not enrolled: no credentials at ${CREDENTIALS_PATH}`);
    }

    const effective = {
        ...config,
        apiUrl: stored.apiUrl || config.apiUrl,
        token: stored.token || config.token,
    };

    assertCredentials(effective);
    assertEncryptedTransport(effective);

    const result = await revokeProbe(effective);
    const probeId = (result && result.probeId) || stored.key;

    logger.log(`Probe revoked on the backend: probe=${probeId}`);
    logger.log(
        `Local credentials kept at ${CREDENTIALS_PATH}; run "logout" to remove them`,
    );

    return result;
}

module.exports = { runRevoke };
