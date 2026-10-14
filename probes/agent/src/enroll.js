'use strict';

const os = require('node:os');
const { spawn } = require('node:child_process');

const { requestJson } = require('./api');
const { VERSION } = require('./version');
const { saveCredentials } = require('./credentials');
const { CREDENTIALS_PATH } = require('./paths');
const { sleep } = require('./util');
const logger = require('./logger');

/** Identifies this client to the enrollment endpoints. */
const DEVICE_FLOW_CLIENT = 'beaconix-probe-cli';

/**
 * Client info sent with enrollment requests so the confirmation page can show
 * the operator what is asking for access.
 */
function clientInfo() {
    return {
        client: DEVICE_FLOW_CLIENT,
        version: VERSION,
        hostname: os.hostname(),
        platform: `${process.platform}/${process.arch}`,
        runtime: process.version,
    };
}

async function requestDeviceAuthorization(config) {
    return requestJson({
        apiUrl: config.apiUrl,
        token: '',
        path: '/probes/enroll/device',
        method: 'POST',
        body: clientInfo(),
        timeoutMs: config.timeoutMs,
    });
}

async function exchangeDeviceCode(config, deviceCode) {
    return requestJson({
        apiUrl: config.apiUrl,
        token: '',
        path: '/probes/enroll/token',
        method: 'POST',
        body: { deviceCode },
        timeoutMs: config.timeoutMs,
    });
}

async function redeemEnrollToken(config, enrollToken) {
    return requestJson({
        apiUrl: config.apiUrl,
        token: '',
        path: '/probes/enroll/redeem',
        method: 'POST',
        body: { token: enrollToken, ...clientInfo() },
        timeoutMs: config.timeoutMs,
    });
}

/** Best-effort browser open so the operator can approve with one click. */
function openBrowser(url) {
    if (!url) return;

    const command =
        process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
              ? 'cmd'
              : 'xdg-open';
    const commandArgs =
        process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

    try {
        const child = spawn(command, commandArgs, {
            stdio: 'ignore',
            detached: true,
        });
        child.on('error', () => undefined);
        child.unref();
    } catch {
        // Best effort: the URL is printed anyway.
    }
}

/** Normalise the credential payload and persist it to the credential store. */
function persistCredential(payload, config) {
    const probeId = payload.probeId || payload.probe && payload.probe.id;
    const secret = payload.secret || payload.probe && payload.probe.secret;

    if (!probeId || !secret) {
        throw new Error('Enrollment endpoint returned no usable credential');
    }

    saveCredentials({
        // The address the CLI actually reached is authoritative — the server's
        // suggested apiUrl is only a fallback (e.g. a CLI left on the default).
        apiUrl: config.apiUrl || payload.apiUrl,
        key: probeId,
        token: secret,
        intervalSeconds: config.intervalSeconds,
        timeoutMs: config.timeoutMs,
        maxResultsPerReport: config.maxResultsPerReport,
        allowInsecure: config.allowInsecure,
    });

    return probeId;
}

/**
 * Path A: OAuth 2.0 device authorization grant (RFC 8628). Print the
 * verification URL + user code, then poll until the operator approves.
 */
async function loginViaDeviceFlow(config, args = {}) {
    logger.log(`Requesting access for ${os.hostname()} (${process.platform}) ...`);

    const device = await requestDeviceAuthorization(config);
    if (!device || !device.deviceCode || !device.userCode) {
        throw new Error('Enrollment endpoint returned an unexpected payload');
    }

    const verifyUrl = device.verificationUriComplete || device.verificationUri;
    console.log('');
    logger.log(`Open:  ${verifyUrl}`);
    logger.log(`Code:  ${device.userCode}`);
    console.log('');

    if (!args.noOpen) {
        openBrowser(verifyUrl);
    }

    const expiresIn = Number(device.expiresIn) || 600;
    const deadline = Date.now() + expiresIn * 1000;
    let waitMs = Math.max(1, Number(device.interval) || 5) * 1000;

    logger.log('Waiting for approval ...');

    while (Date.now() < deadline) {
        await sleep(waitMs);

        const result = await exchangeDeviceCode(config, device.deviceCode);
        const status = result && result.status;

        if (status === 'approved') {
            const probeId = persistCredential(result.credential || {}, config);
            logger.log(`Enrollment approved: probe=${probeId}`);
            logger.log(`Credentials saved to ${CREDENTIALS_PATH}`);
            return { ok: true, probeId };
        }

        if (status === 'denied') {
            throw new Error('Enrollment was denied in the browser');
        }

        if (status === 'expired') {
            throw new Error('Enrollment code expired before it was approved');
        }

        if (status === 'slow_down') {
            waitMs += 5000;
        }
        // `pending` (and anything unknown) keeps polling until the deadline.
    }

    throw new Error(
        `Timed out after ${expiresIn}s waiting for approval; run "login" again`,
    );
}

/**
 * Path B: redeem a one-time enrollment token issued from the web UI. No
 * browser interaction on this host.
 */
async function enrollWithToken(config, enrollToken) {
    if (!enrollToken) {
        throw new Error(
            'Missing --enroll-token; generate one from the web UI (Probes → Add probe)',
        );
    }

    logger.log(`Redeeming enrollment token for ${os.hostname()} ...`);

    const result = await redeemEnrollToken(config, enrollToken);
    const probeId = persistCredential(result || {}, config);

    logger.log(`Enrollment complete: probe=${probeId}`);
    logger.log(`Credentials saved to ${CREDENTIALS_PATH}`);
    return { ok: true, probeId };
}

module.exports = {
    DEVICE_FLOW_CLIENT,
    clientInfo,
    requestDeviceAuthorization,
    exchangeDeviceCode,
    redeemEnrollToken,
    persistCredential,
    openBrowser,
    loginViaDeviceFlow,
    enrollWithToken,
};
