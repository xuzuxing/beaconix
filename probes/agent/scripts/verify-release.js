#!/usr/bin/env node
'use strict';

/**
 * Verify that a probe release is internally consistent at its download URL.
 *
 * The install chain has three moving parts that must agree:
 *   latest.json                          -> { version, sha256, installUrl }
 *   beaconix-probe-<version>.tar.gz      -> the immutable build
 *   beaconix-probe-latest.tar.gz         -> a byte-identical alias of it
 *
 * A release where the alias still points at the previous build silently keeps
 * every `install.sh` / container start on the old agent, so check it after every
 * upload (`pnpm probe:verify`).
 *
 * Usage:
 *   node probes/agent/scripts/verify-release.js [--base-url <url>] [--no-scf]
 */

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const DEFAULT_BASE_URL = 'https://get.beaconix.app/probe';

function parseArgs(argv) {
    const opts = {
        baseUrl: DEFAULT_BASE_URL,
        checkScf: true,
        help: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '-h' || arg === '--help') {
            opts.help = true;
        } else if (arg === '--base-url') {
            if (i + 1 >= argv.length) throw new Error('--base-url needs a value');
            opts.baseUrl = argv[++i].replace(/\/+$/, '');
        } else if (arg === '--no-scf') {
            opts.checkScf = false;
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }

    return opts;
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readTarEntry(buffer, name) {
    let offset = 0;

    while (offset + 512 <= buffer.length) {
        const header = buffer.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) break;

        const rawName = header
            .toString('utf8', 0, 100)
            .replace(/\0.*$/, '')
            .replace(/^\.\//, '');
        const size = Number.parseInt(
            header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim(),
            8,
        );
        const start = offset + 512;

        if (rawName === name) {
            return buffer.subarray(start, start + size).toString('utf8');
        }
        offset = start + Math.ceil((Number.isFinite(size) ? size : 0) / 512) * 512;
    }

    return null;
}

function releaseJson(tarball) {
    const entry = readTarEntry(zlib.gunzipSync(tarball), 'RELEASE.json');
    if (!entry) throw new Error('archive has no RELEASE.json');
    return JSON.parse(entry);
}

async function fetchBinary(url) {
    const response = await fetch(url, {
        headers: { 'cache-control': 'no-cache' },
    });
    if (!response.ok) {
        throw new Error(`${url} -> HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

async function main(argv) {
    const opts = parseArgs(argv);
    if (opts.help) {
        console.log(
            'Verify a published probe release.\n\n' +
                '  node probes/agent/scripts/verify-release.js [--base-url <url>] [--no-scf]\n',
        );
        return;
    }

    const base = opts.baseUrl;
    const failures = [];
    const warnings = [];
    const check = (ok, label, detail, options = {}) => {
        const soft = Boolean(options.soft);
        const prefix = ok ? 'OK  ' : soft ? 'WARN' : 'FAIL';
        console.log(`${prefix} ${label}${detail ? ` — ${detail}` : ''}`);
        if (!ok) (soft ? warnings : failures).push(label);
    };

    const manifest = JSON.parse(
        (await fetchBinary(`${base}/latest.json`)).toString('utf8'),
    );
    check(Boolean(manifest.version), 'latest.json version', manifest.version);
    check(Boolean(manifest.sha256), 'latest.json sha256', manifest.sha256);
    check(Boolean(manifest.installUrl), 'latest.json installUrl', manifest.installUrl);

    const versionUrl = `${base}/beaconix-probe-${manifest.version}.tar.gz`;
    const versionTarball = await fetchBinary(versionUrl);
    const versionSha = sha256(versionTarball);
    check(versionSha === manifest.sha256, `${manifest.version} tarball sha256`, versionSha);

    let versionRelease = null;
    try {
        versionRelease = releaseJson(versionTarball);
    } catch (err) {
        check(false, `${manifest.version} tarball RELEASE.json`, err.message);
    }
    if (versionRelease) {
        check(
            versionRelease.version === manifest.version,
            `${manifest.version} tarball version`,
            versionRelease.version,
        );
    }

    const aliasTarball = await fetchBinary(`${base}/beaconix-probe-latest.tar.gz`);
    const aliasSha = sha256(aliasTarball);
    // Compatibility only: installers resolve `latest` through latest.json and
    // download the versioned tarball, so a stale alias no longer pins a build.
    check(
        aliasSha === manifest.sha256,
        'latest alias sha256',
        aliasSha === manifest.sha256 ? 'matches' : `${aliasSha} != ${manifest.sha256}`,
        { soft: true },
    );

    try {
        const aliasRelease = releaseJson(aliasTarball);
        check(
            aliasRelease.version === manifest.version,
            'latest alias version',
            aliasRelease.version,
            { soft: true },
        );
    } catch (err) {
        check(false, 'latest alias RELEASE.json', err.message, { soft: true });
    }

    if (opts.checkScf && manifest.scf && manifest.scf.tarball) {
        try {
            const zip = await fetchBinary(manifest.scf.tarball);
            check(zip.length > 0, 'scf zip', `${zip.length} bytes`);
        } catch (err) {
            check(false, 'scf zip', err.message);
        }
    }

    const installerUrl = manifest.installUrl || `${base}/install.sh`;
    try {
        const installer = (
            await fetchBinary(installerUrl)
        ).toString('utf8');
        check(
            installer.includes('beaconix-probe-$VERSION.tar.gz'),
            'install.sh download pattern',
            installerUrl,
        );
    } catch (err) {
        check(false, 'install.sh', err.message);
    }

    console.log('');
    if (warnings.length > 0) {
        console.warn(
            `warning: ${warnings.length} compatibility check(s) failed — the latest alias is only a fallback now; re-upload it when convenient`,
        );
    }
    if (failures.length > 0) {
        console.error(
            `${failures.length} check(s) failed: the manifest or the versioned tarball is stale.\n` +
                'Re-upload the missing artifact(s) and purge the CDN cache, then run this again.',
        );
        process.exitCode = 1;
        return;
    }

    console.log(`Release ${manifest.version} is consistent at ${base}`);
}

main(process.argv.slice(2)).catch((err) => {
    console.error(`verify-release: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
});
