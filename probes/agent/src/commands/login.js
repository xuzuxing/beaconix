'use strict';

const { loginViaDeviceFlow } = require('../enroll');
const { assertEncryptedTransport } = require('../preflight');

/** `beaconix-probe login` — Path A (device authorization grant). */
async function runLogin(config, args) {
    assertEncryptedTransport(config);
    return loginViaDeviceFlow(config, args);
}

module.exports = { runLogin };
