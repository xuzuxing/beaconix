'use strict';

/** Pre-flight checks shared by the probe and enrollment commands. */

function assertCredentials(config) {
    const missing = [];
    if (!config.key) missing.push('PROBE_KEY');
    if (!config.token) missing.push('PROBE_TOKEN');

    if (missing.length > 0) {
        throw new Error(
            `Missing probe credential(s): ${missing.join(', ')}. ` +
                'Run `beaconix-probe login` (or `enroll`), or set ' +
                '--key/--token, environment variables, or --config.',
        );
    }
}

/**
 * Enforce encrypted transport. Plain http is only reachable when explicitly
 * allowed (localhost testing) via --allow-insecure / PROBE_ALLOW_INSECURE.
 */
function assertEncryptedTransport(config) {
    let url;
    try {
        url = new URL(config.apiUrl);
    } catch {
        throw new Error(`Invalid API URL: ${config.apiUrl}`);
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(
            `Unsupported API URL protocol "${url.protocol}" (expected http or https)`,
        );
    }

    if (url.protocol === 'http:' && !config.allowInsecure) {
        throw new Error(
            `Insecure API URL "${config.apiUrl}" uses plain http. ` +
                'Data encryption requires https. Use an https API URL or ' +
                'set PROBE_ALLOW_INSECURE=true to override (not recommended).',
        );
    }

    return url.protocol === 'https:';
}

module.exports = { assertCredentials, assertEncryptedTransport };
