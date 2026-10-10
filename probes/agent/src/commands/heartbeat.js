'use strict';

const { heartbeat } = require('../api');
const { assertCredentials } = require('../preflight');

/** Send a single heartbeat and print the raw response (troubleshooting). */
async function runHeartbeat(config) {
    assertCredentials(config);
    const data = await heartbeat(config);
    console.log(JSON.stringify(data, null, 2));
    return data;
}

module.exports = { runHeartbeat };
