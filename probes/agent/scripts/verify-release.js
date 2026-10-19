#!/usr/bin/env node
'use strict';

/**
 * Verify that a probe release is internally consistent at its download URL.
 *
 * With the versioned layout (build-release.js default) the install chain has
 * these moving parts, and they must all agree:
 *
 *   latest.json                                  -> { version, sha256, tarball }
 *   <version>/beaconix-probe-<version>.tar.gz    -> the immutable build
 *   <version>/latest.json                        -> manifest for that version
 *   <version>/SHA256SUMS                         -> version-local checksums
 *   beaconix-probe-latest.tar.gz                 -> byte-identical alias
 *   install.sh (bucket root)                     -> resolves <base>/<version>/…
 *
 * A release whose manifest, versioned tarball, or installer disagree silently
 * keeps every `install.sh` / container start on the old agent, so check it after
 * every upload (`pnpm probe:verify`). `--layout flat` still verifies releases
 * published with the legacy flat layout.
 *
 * Usage:
 *   node probes/agent/scripts/verify-release.js [--base-url <url>]
 *        [--layout auto|versioned|flat] [--no-scf]
 */

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const DEFAULT_BASE_URL = 'https://get.beaconix.app/probe';
const LAYOUTS = ['auto', 'versioned', 'flat'];

function parseArgs(argv) {
    const opts = {
        baseUrl: DEFAULT_BASE_URL,
        layout: 'auto',
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
        } else if (arg === '--layout') {
            if (i + 1 >= argv.length) throw new Error('--layout needs a value');
            opts.layout = argv[++i];
            if (!LAYOUTS.includes(opts.layout)) {
                throw new Error(`--layout must be ${LAYOUTS.join(', ')}`);
            }
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

/** Like fetchBinary, but a missing artifact is a check result, not a crash. */
async function fetchOptional(url) {
    try {
        return await fetchBinary(url);
    } catch {
        return null;
    }
}

/** `sha256sum -c` compatible file: `sha  name` (newest entries win). */
function parseSums(text) {
    const sums = new Map();
    for (const line of text.split('\n')) {
        const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
        if (match) sums.set(match[2], match[1].toLowerCase());
    }
    return sums;
}

async function main(argv) {
    const opts = parseArgs(argv);
    if (opts.help) {
        console.log(
            'Verify a published probe release.\n\n' +
                '  node probes/agent/scripts/verify-release.js [--base-url <url>]\n' +
                '       [--layout auto|versioned|flat] [--no-scf]\n',
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
    const version = manifest.version;
    check(Boolean(version), 'latest.json version', version);
    check(Boolean(manifest.sha256), 'latest.json sha256', manifest.sha256 || 'missing');
    check(Boolean(manifest.installUrl), 'latest.json installUrl', manifest.installUrl);

    // ---- layout + payload ------------------------------------------------
    // The installer tries the versioned URL first, so the verifier does too and
    // only falls back to the legacy flat path when that is what is published.
    const versionedTarballUrl = `${base}/${version}/beaconix-probe-${version}.tar.gz`;
    const flatTarballUrl = `${base}/beaconix-probe-${version}.tar.gz`;
    let layout = opts.layout;
    let tarballUrl = null;
    let versionTarball = null;

    if (layout !== 'flat') {
        versionTarball = await fetchOptional(versionedTarballUrl);
        if (versionTarball) {
            tarballUrl = versionedTarballUrl;
            layout = 'versioned';
        } else if (layout === 'versioned') {
            check(false, 'versioned tarball', `${versionedTarballUrl} is missing`);
        }
    }
    if (!versionTarball && layout !== 'versioned') {
        versionTarball = await fetchOptional(flatTarballUrl);
        if (versionTarball) {
            tarballUrl = flatTarballUrl;
            check(
                true,
                'layout flat (legacy)',
                `${flatTarballUrl} — publish <version>/ directories instead`,
                { soft: opts.layout === 'auto' },
            );
            layout = 'flat';
        }
    }

    let versionSums = null;
    if (versionTarball) {
        check(Boolean(version), 'release tarball', tarballUrl);

        if (manifest.tarball) {
            check(
                manifest.tarball === tarballUrl,
                'latest.json tarball matches the layout',
                manifest.tarball === tarballUrl
                    ? tarballUrl
                    : `${manifest.tarball} != ${tarballUrl}`,
                { soft: true },
            );
        }

        const versionSha = sha256(versionTarball);
        check(versionSha === manifest.sha256, `${version} tarball sha256`, versionSha);

        let versionRelease = null;
        try {
            versionRelease = releaseJson(versionTarball);
        } catch (err) {
            check(false, `${version} tarball RELEASE.json`, err.message);
        }
        if (versionRelease) {
            check(
                versionRelease.version === version,
                `${version} tarball version`,
                versionRelease.version,
            );
        }
    } else {
        check(
            false,
            'release tarball',
            `neither ${versionedTarballUrl} nor ${flatTarballUrl} is available`,
        );
    }

    // ---- per-version manifest + checksums --------------------------------
    if (layout === 'versioned') {
        const versionManifestBytes = await fetchOptional(`${base}/${version}/latest.json`);
        if (versionManifestBytes) {
            try {
                const versionManifest = JSON.parse(versionManifestBytes.toString('utf8'));
                check(
                    versionManifest.version === version &&
                        versionManifest.sha256 === manifest.sha256,
                    `${version}/latest.json matches the root manifest`,
                    versionManifest.version === version ? 'version + sha256 agree' : versionManifest.version,
                );
            } catch (err) {
                check(false, `${version}/latest.json`, err.message);
            }
        } else {
            check(false, `${version}/latest.json`, 'missing', { soft: true });
        }

        const sumsBytes = await fetchOptional(`${base}/${version}/SHA256SUMS`);
        if (sumsBytes) {
            versionSums = parseSums(sumsBytes.toString('utf8'));
            const expected = versionSums.get(`beaconix-probe-${version}.tar.gz`);
            check(Boolean(expected), `${version}/SHA256SUMS lists the tarball`, expected || 'missing');
            if (expected && versionTarball) {
                check(
                    expected === sha256(versionTarball),
                    `${version}/SHA256SUMS tarball sha256`,
                    expected,
                );
            }
        } else {
            check(false, `${version}/SHA256SUMS`, 'missing', { soft: true });
        }
    }

    // ---- compatibility alias ---------------------------------------------
    const aliasTarball = await fetchOptional(`${base}/beaconix-probe-latest.tar.gz`);
    if (aliasTarball) {
        const aliasSha = sha256(aliasTarball);
        // Installers resolve `latest` through latest.json and download the
        // versioned tarball, so a stale alias no longer pins a build.
        check(
            aliasSha === manifest.sha256,
            'latest alias sha256',
            aliasSha === manifest.sha256 ? 'matches' : `${aliasSha} != ${manifest.sha256}`,
            { soft: true },
        );

        try {
            const aliasRelease = releaseJson(aliasTarball);
            check(
                aliasRelease.version === version,
                'latest alias version',
                aliasRelease.version,
                { soft: true },
            );
        } catch (err) {
            check(false, 'latest alias RELEASE.json', err.message, { soft: true });
        }
    } else {
        check(false, 'latest alias', 'missing', { soft: true });
    }

    // ---- SCF zip ---------------------------------------------------------
    if (opts.checkScf && manifest.scf && manifest.scf.tarball) {
        const zip = await fetchOptional(manifest.scf.tarball);
        if (zip) {
            check(zip.length > 0, 'scf zip', `${zip.length} bytes`);
            const scfName = `beaconix-probe-scf-${version}.zip`;
            if (versionSums && versionSums.has(scfName)) {
                check(
                    versionSums.get(scfName) === sha256(zip),
                    'scf zip sha256',
                    versionSums.get(scfName),
                );
            }
            if (layout === 'versioned') {
                check(
                    manifest.scf.tarball.includes(`/${version}/`),
                    'scf tarball lives in the version directory',
                    manifest.scf.tarball,
                    { soft: true },
                );
            }
        } else {
            check(false, 'scf zip', `${manifest.scf.tarball} is not reachable`);
        }
    }

    // ---- installer -------------------------------------------------------
    const installerUrl = manifest.installUrl || `${base}/install.sh`;
    const installerBytes = await fetchOptional(installerUrl);
    if (installerBytes) {
        const installer = installerBytes.toString('utf8');
        check(/latest\.json/.test(installer), 'install.sh resolves latest.json', installerUrl);
        const versionedPattern =
            /\/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/beaconix-probe-\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\.tar\.gz/;
        if (layout === 'versioned') {
            check(
                versionedPattern.test(installer),
                'install.sh downloads <base>/<version>/<tarball>',
                installerUrl,
            );
        } else {
            check(
                versionedPattern.test(installer) ||
                    /beaconix-probe-[^"'`]*\.tar\.gz/.test(installer),
                'install.sh download pattern',
                installerUrl,
            );
        }
    } else {
        check(false, 'install.sh', `${installerUrl} is not reachable`);
    }

    // ---- release history -------------------------------------------------
    const historyBytes = await fetchOptional(`${base}/version.json`);
    if (historyBytes) {
        try {
            const history = JSON.parse(historyBytes.toString('utf8'));
            const entry = (history.versions || []).find((item) => item.version === version);
            check(Boolean(entry), 'version.json lists this version', entry ? version : 'missing', {
                soft: true,
            });
            if (entry) {
                check(entry.sha256 === manifest.sha256, 'version.json sha256', entry.sha256, {
                    soft: true,
                });
            }
        } catch (err) {
            check(false, 'version.json', err.message, { soft: true });
        }
    } else {
        check(false, 'version.json', 'missing', { soft: true });
    }

    console.log('');
    if (warnings.length > 0) {
        console.warn(
            `warning: ${warnings.length} compatibility check(s) failed — installers fall back gracefully, but re-upload the artifact when convenient`,
        );
    }
    if (failures.length > 0) {
        console.error(
            `${failures.length} check(s) failed: the manifest, the versioned tarball or the installer is stale.\n` +
                'Re-upload the missing artifact(s) and purge the CDN cache, then run this again.',
        );
        process.exitCode = 1;
        return;
    }

    console.log(`Release ${version} (${layout}) is consistent at ${base}`);
}

main(process.argv.slice(2)).catch((err) => {
    console.error(`verify-release: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
});
