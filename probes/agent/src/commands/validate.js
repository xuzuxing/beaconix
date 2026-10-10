'use strict';

const { heartbeat } = require('../api');
const { pollAndAnswerValidation } = require('../validation');
const { assertCredentials, assertEncryptedTransport } = require('../preflight');
const logger = require('../logger');

/**
 * One-shot deployment validation: verify TLS, answer a pending challenge (if
 * any), round-trip a heartbeat, and confirm the key the backend sees matches.
 */
async function runValidate(config) {
    assertCredentials(config);
    const encrypted = assertEncryptedTransport(config);

    logger.log(`Validating probe ${config.key} against ${config.apiUrl}`);
    logger.log(
        `Transport encryption: ${encrypted ? 'TLS (https)' : 'INSECURE (http, explicitly allowed)'}`,
    );

    await pollAndAnswerValidation(config);

    const startedAt = Date.now();
    const data = await heartbeat(config);
    const latency = Date.now() - startedAt;

    if (!data || typeof data !== 'object') {
        throw new Error('Heartbeat returned an unexpected payload');
    }

    if (!data.probe || typeof data.probe !== 'object') {
        throw new Error('Heartbeat response is missing probe metadata');
    }

    if (data.probe.id !== config.key) {
        throw new Error(
            `Probe key mismatch: expected "${config.key}", got "${data.probe.id}"`,
        );
    }

    const monitors = Array.isArray(data.monitors) ? data.monitors : [];

    logger.log('Connectivity check: OK (heartbeat round-trip)');
    logger.log(`Probe identity: id=${data.probe.id} status=${data.probe.status}`);
    logger.log(`Assigned monitors: ${monitors.length}`);
    logger.log(`Server time: ${data.serverTime ?? 'n/a'} (round-trip ${latency}ms)`);

    return {
        ok: true,
        probeId: data.probe.id,
        status: data.probe.status,
        monitorCount: monitors.length,
        latency,
        encrypted,
    };
}

module.exports = { runValidate };
