'use strict';

const { VERSION } = require('../version');
const logger = require('../logger');

const DEFAULT_DOWNLOAD_BASE = 'https://get.beacon.dev/probe';

/** Fetch the published release manifest ({ version, installUrl? }). */
async function fetchManifest(base) {
    const url = `${base}/latest.json`;
    let response;
    try {
        response = await fetch(url, { headers: { accept: 'application/json' } });
    } catch (err) {
        throw new Error(`Cannot reach the update server ${url}: ${err.message}`);
    }
    if (!response.ok) {
        throw new Error(`Update manifest ${url} returned HTTP ${response.status}`);
    }
    return response.json();
}

/**
 * `beacon-probe self-update [--check]`.
 *
 * Replacing the payload under /opt and refreshing the unit needs root, so this
 * command reports the installer invocation instead of mutating system files
 * from an unprivileged process.
 */
async function runSelfUpdate(args) {
    const base = (process.env.BEACON_DOWNLOAD_BASE || DEFAULT_DOWNLOAD_BASE).replace(
        /\/+$/,
        '',
    );

    const manifest = await fetchManifest(base);
    const latest = manifest && manifest.version;
    if (!latest) {
        throw new Error('Update manifest is missing a version');
    }

    const updateAvailable = latest !== VERSION;
    logger.log(`Installed: ${VERSION}`);
    logger.log(`Latest:    ${latest}`);

    if (args.check) {
        logger.log(updateAvailable ? 'An update is available.' : 'Up to date.');
        return { ok: true, current: VERSION, latest, updateAvailable };
    }

    if (!updateAvailable) {
        logger.log('Already up to date.');
        return {
            ok: true,
            current: VERSION,
            latest,
            updateAvailable: false,
            updated: false,
        };
    }

    const installUrl = manifest.installUrl || `${base}/install.sh`;
    const command = `curl -fsSL ${installUrl} | sudo sh -s -- --version=${latest}`;
    logger.log('To update, run:');
    logger.log(`  ${command}`);
    return {
        ok: true,
        current: VERSION,
        latest,
        updateAvailable: true,
        updated: false,
        command,
    };
}

module.exports = { runSelfUpdate, fetchManifest, DEFAULT_DOWNLOAD_BASE };
