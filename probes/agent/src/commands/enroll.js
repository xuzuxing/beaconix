'use strict';

const { enrollWithToken } = require('../enroll');
const { assertEncryptedTransport } = require('../preflight');

/** `beacon-probe enroll --enroll-token <t>` — Path B (web-issued token). */
async function runEnroll(config, args) {
    assertEncryptedTransport(config);
    return enrollWithToken(config, args.enrollToken);
}

module.exports = { runEnroll };
