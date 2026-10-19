#!/usr/bin/env node
'use strict';

/**
 * Publish a built probe release to the download host (Cloudflare R2 / any
 * S3-compatible store).
 *
 * `pnpm probe:pack` produces `probes/agent/dist`, which already mirrors the
 * download root. This script uploads it in the one order that keeps installs
 * safe, with the cache policy from RELEASE.md §5:
 *
 *   1. <prefix>/<version>/**            immutable, 1 year
 *   2. <prefix>/version.json            short cache
 *   3. <prefix>/latest.json             short cache — the switch-over point
 *   4. <prefix>/beaconix-probe-latest.tar.gz   short cache (fallback alias)
 *   5. install.sh (bucket root)         short cache
 *
 * A failure before step 3 leaves every installer on the previous release, so
 * the upload is safe to re-run. Immutable objects whose size already matches are
 * skipped unless --force is given; the moving pointers are always re-uploaded.
 *
 * Credentials (first match wins):
 *   --endpoint / PROBE_R2_ENDPOINT / STORAGE_OSS_ENDPOINT
 *   --bucket   / PROBE_R2_BUCKET   / STORAGE_OSS_BUCKET   (needs --allow-storage-bucket)
 *              PROBE_R2_ACCESS_KEY_ID     / STORAGE_OSS_ACCESS_KEY_ID
 *              PROBE_R2_SECRET_ACCESS_KEY / STORAGE_OSS_ACCESS_KEY_SECRET
 *              PROBE_R2_REGION (default auto)
 *
 * Usage:
 *   node probes/agent/scripts/publish-release.js [options]
 *
 *   --dist <dir>          Build output to publish (default: probes/agent/dist)
 *   --prefix <path>       Key prefix inside the bucket (default: probe)
 *   --version <x.y.z>     Publish only this version directory
 *   --install-key <key>   Installer key, relative to the bucket root (default install.sh)
 *   --no-installer        Do not upload install.sh
 *   --public-base-url <u> Public URL of <prefix>, used for the post-upload hint
 *   --env-file <path>     Load KEY=VALUE pairs (default: ./.env when present)
 *   --dry-run             Print the plan without uploading
 *   --force               Re-upload immutable objects even when the size matches
 *   --no-verify           Skip the post-upload HeadObject check
 *   -h, --help            Show this help
 */

const fs = require('node:fs');
const path = require('node:path');

const AGENT_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(AGENT_DIR, '..', '..');
const DEFAULT_DIST = path.join(AGENT_DIR, 'dist');

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const SHORT_CACHE = 'public, max-age=60, must-revalidate';
const ALIAS_CACHE = 'public, max-age=300';
const ALIAS_NAME = 'beaconix-probe-latest.tar.gz';

const HELP = `Publish a built probe release to R2 / S3-compatible storage.

Usage:
  node probes/agent/scripts/publish-release.js [options]

Options:
  --dist <dir>           Build output to publish (default: probes/agent/dist)
  --prefix <path>        Key prefix inside the bucket (default: probe)
  --version <x.y.z>      Publish only this version directory
  --install-key <key>    Installer key relative to the bucket root (default: install.sh)
  --no-installer         Do not upload install.sh
  --public-base-url <u>  Public URL of the prefix (default: derived from latest.json)
  --env-file <path>      Load KEY=VALUE pairs (default: <repo>/.env when present)
  --dry-run              Show the plan without uploading
  --force                Re-upload immutable objects even when the size matches
  --no-verify            Skip the post-upload HeadObject check
  -h, --help             Show this help

Credentials: PROBE_R2_ENDPOINT / PROBE_R2_BUCKET / PROBE_R2_ACCESS_KEY_ID /
PROBE_R2_SECRET_ACCESS_KEY (falling back to STORAGE_OSS_*; a bucket that comes
from STORAGE_OSS_BUCKET additionally requires --allow-storage-bucket).`;

function stripTrailingSlash(value) {
    return String(value).replace(/\/+$/, '');
}

function requireValue(argv, index, option) {
    if (index >= argv.length) throw new Error(`${option} requires a value`);
    return argv[index];
}

function parseArgs(argv) {
    const opts = {
        dist: DEFAULT_DIST,
        prefix: process.env.PROBE_R2_PREFIX || 'probe',
        version: undefined,
        installKey: 'install.sh',
        uploadInstaller: true,
        publicBaseUrl: undefined,
        envFile: path.join(REPO_ROOT, '.env'),
        allowStorageBucket: false,
        dryRun: false,
        force: false,
        verify: true,
        forcePathStyle: undefined,
        help: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--') {
            // `pnpm probe:publish -- --dry-run` forwards the separator verbatim.
            continue;
        }
        if (arg === '-h' || arg === '--help') {
            opts.help = true;
        } else if (arg === '--dist') {
            opts.dist = path.resolve(requireValue(argv, ++i, arg));
        } else if (arg === '--prefix') {
            opts.prefix = stripTrailingSlash(requireValue(argv, ++i, arg));
        } else if (arg === '--version') {
            opts.version = requireValue(argv, ++i, arg);
            if (!SEMVER.test(opts.version)) {
                throw new Error(`Invalid --version value: ${opts.version}`);
            }
        } else if (arg === '--install-key') {
            opts.installKey = requireValue(argv, ++i, arg).replace(/^\/+/, '');
        } else if (arg === '--no-installer') {
            opts.uploadInstaller = false;
        } else if (arg === '--public-base-url') {
            opts.publicBaseUrl = stripTrailingSlash(requireValue(argv, ++i, arg));
        } else if (arg === '--env-file') {
            opts.envFile = path.resolve(requireValue(argv, ++i, arg));
        } else if (arg === '--allow-storage-bucket') {
            opts.allowStorageBucket = true;
        } else if (arg === '--dry-run') {
            opts.dryRun = true;
        } else if (arg === '--force') {
            opts.force = true;
        } else if (arg === '--no-verify') {
            opts.verify = false;
        } else if (arg === '--force-path-style') {
            opts.forcePathStyle = true;
        } else if (arg === '--no-force-path-style') {
            opts.forcePathStyle = false;
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }

    return opts;
}

/** Minimal KEY=VALUE loader so the script follows the repo's .env. */
function loadEnvFile(file) {
    if (!file || !fs.existsSync(file)) return {};
    const values = {};
    for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match) continue;
        let value = match[2];
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        values[match[1]] = value;
    }
    return values;
}

function resolveConfig(opts, env) {
    const pick = (...names) => {
        for (const name of names) {
            if (env[name]) return env[name];
        }
        return undefined;
    };

    const endpoint = pick('PROBE_R2_ENDPOINT', 'STORAGE_OSS_ENDPOINT');
    const bucketFromProbe = pick('PROBE_R2_BUCKET');
    const bucket = bucketFromProbe || pick('STORAGE_OSS_BUCKET');
    const accessKeyId = pick('PROBE_R2_ACCESS_KEY_ID', 'STORAGE_OSS_ACCESS_KEY_ID');
    const secretAccessKey = pick(
        'PROBE_R2_SECRET_ACCESS_KEY',
        'STORAGE_OSS_ACCESS_KEY_SECRET',
    );
    const region = pick('PROBE_R2_REGION', 'STORAGE_OSS_REGION') || 'auto';

    const missing = [];
    if (!endpoint && !opts.dryRun) missing.push('PROBE_R2_ENDPOINT');
    if (!bucket && !opts.dryRun) missing.push('PROBE_R2_BUCKET');
    if (!accessKeyId && !opts.dryRun) missing.push('PROBE_R2_ACCESS_KEY_ID');
    if (!secretAccessKey && !opts.dryRun) missing.push('PROBE_R2_SECRET_ACCESS_KEY');
    if (missing.length > 0) {
        throw new Error(
            `Missing storage configuration: ${missing.join(', ')}\n` +
                'Set them in the environment or in .env (see --help).',
        );
    }

    if (!bucketFromProbe && bucket && !opts.allowStorageBucket && !opts.dryRun) {
        throw new Error(
            `Refusing to publish into STORAGE_OSS_BUCKET (${bucket}): that is the ` +
                'attachment bucket. Set PROBE_R2_BUCKET, or pass --allow-storage-bucket ' +
                'if the release really belongs there.',
        );
    }

    let forcePathStyle = opts.forcePathStyle;
    if (forcePathStyle === undefined) {
        forcePathStyle = /^(1|true|yes)$/i.test(
            pick('PROBE_R2_FORCE_PATH_STYLE', 'STORAGE_OSS_FORCE_PATH_STYLE') || '',
        );
    }

    return {
        endpoint: endpoint || 'http://dry-run.invalid',
        bucket: bucket || 'dry-run-bucket',
        accessKeyId: accessKeyId || 'dry-run',
        secretAccessKey: secretAccessKey || 'dry-run',
        region,
        forcePathStyle,
    };
}

function contentTypeFor(name) {
    if (name.endsWith('.json')) return 'application/json; charset=utf-8';
    if (name.endsWith('.tar.gz')) return 'application/gzip';
    if (name.endsWith('.zip')) return 'application/zip';
    if (name.endsWith('.sh')) return 'text/x-shellscript; charset=utf-8';
    if (name === 'SHA256SUMS') return 'text/plain; charset=utf-8';
    return 'application/octet-stream';
}

function listFiles(dir) {
    const files = [];
    for (const name of fs.readdirSync(dir).sort()) {
        const abs = path.join(dir, name);
        if (fs.statSync(abs).isFile()) files.push({ name, abs });
    }
    return files;
}

/**
 * Build the ordered upload list. Order is the safety property: everything the
 * current manifest points at is uploaded before the manifest that points at it.
 */
function collectUploads(opts) {
    if (!fs.existsSync(opts.dist)) {
        throw new Error(`Build output not found: ${opts.dist} (run pnpm probe:pack)`);
    }

    const entries = fs.readdirSync(opts.dist).sort();
    let versions = entries.filter((name) => {
        const abs = path.join(opts.dist, name);
        return SEMVER.test(name) && fs.statSync(abs).isDirectory();
    });
    if (opts.version) {
        if (!versions.includes(opts.version)) {
            throw new Error(`${opts.dist} has no ${opts.version}/ directory`);
        }
        versions = [opts.version];
    }
    if (versions.length === 0) {
        throw new Error(`${opts.dist} has no version directory (run pnpm probe:pack)`);
    }

    const hasRootManifest = fs.existsSync(path.join(opts.dist, 'latest.json'));
    const uploads = [];

    // 1. Immutable per-version artifacts.
    for (const version of versions) {
        for (const file of listFiles(path.join(opts.dist, version))) {
            uploads.push({
                key: `${opts.prefix}/${version}/${file.name}`,
                file: file.abs,
                size: fs.statSync(file.abs).size,
                cacheControl: IMMUTABLE_CACHE,
                contentType: contentTypeFor(file.name),
                mutable: false,
            });
        }
    }

    // 2. Release history.
    const history = path.join(opts.dist, 'version.json');
    if (fs.existsSync(history)) {
        uploads.push({
            key: `${opts.prefix}/version.json`,
            file: history,
            size: fs.statSync(history).size,
            cacheControl: SHORT_CACHE,
            contentType: 'application/json; charset=utf-8',
            mutable: true,
        });
    }

    // 3. Pointer: after this lands, new installs pick up the new release.
    if (hasRootManifest) {
        const manifest = path.join(opts.dist, 'latest.json');
        uploads.push({
            key: `${opts.prefix}/latest.json`,
            file: manifest,
            size: fs.statSync(manifest).size,
            cacheControl: SHORT_CACHE,
            contentType: 'application/json; charset=utf-8',
            mutable: true,
        });

        // 4. Fallback alias, used only when the manifest is unreachable.
        const alias = path.join(opts.dist, ALIAS_NAME);
        if (fs.existsSync(alias)) {
            uploads.push({
                key: `${opts.prefix}/${ALIAS_NAME}`,
                file: alias,
                size: fs.statSync(alias).size,
                cacheControl: ALIAS_CACHE,
                contentType: 'application/gzip',
                mutable: true,
            });
        }
    }

    // 5. Installer at the bucket root (a new install starts here).
    if (opts.uploadInstaller && opts.installKey) {
        const installer = path.join(opts.dist, 'install.sh');
        if (fs.existsSync(installer)) {
            uploads.push({
                key: opts.installKey,
                file: installer,
                size: fs.statSync(installer).size,
                cacheControl: SHORT_CACHE,
                contentType: 'text/x-shellscript; charset=utf-8',
                mutable: true,
            });
        }
    }

    return { uploads, versions, hasRootManifest };
}

function publicBaseUrl(opts) {
    if (opts.publicBaseUrl) return opts.publicBaseUrl;
    if (process.env.PROBE_PUBLIC_BASE_URL) {
        return stripTrailingSlash(process.env.PROBE_PUBLIC_BASE_URL);
    }
    const manifestPath = path.join(opts.dist, 'latest.json');
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const match = /^(.*)\/[^/]+\/[^/]+\.tar\.gz$/.exec(manifest.tarball || '');
        if (match) return match[1];
    } catch {
        /* no manifest: the hint is simply omitted */
    }
    return undefined;
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function labelFor(key, opts) {
    return key === opts.installKey ? `${key} (bucket root)` : key;
}

async function headSize(client, bucket, key) {
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return head.ContentLength;
    } catch (err) {
        const status = err && err.$metadata ? err.$metadata.httpStatusCode : undefined;
        if (status === 404 || (err && err.name === 'NotFound')) return null;
        throw err;
    }
}

async function publish(opts, config) {
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const client = new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
    });

    const { uploads, versions, hasRootManifest } = collectUploads(opts);
    const target = `s3://${config.bucket}/${opts.prefix || ''}`;
    console.log(`Publishing ${path.relative(REPO_ROOT, opts.dist) || opts.dist} -> ${target}`);
    console.log(`Versions: ${versions.join(', ')}${hasRootManifest ? '' : ' (pre-release: no root latest.json)'}`);
    console.log('');

    const uploaded = [];
    const skipped = [];

    for (const item of uploads) {
        const label = labelFor(item.key, opts);
        let existing = null;
        if (!opts.force && !item.mutable && !opts.dryRun) {
            existing = await headSize(client, config.bucket, item.key);
        }

        if (existing === item.size && !item.mutable) {
            console.log(`  = ${label.padEnd(46)} ${formatBytes(item.size).padStart(9)}  unchanged`);
            skipped.push(item);
            continue;
        }

        if (opts.dryRun) {
            console.log(`  + ${label.padEnd(46)} ${formatBytes(item.size).padStart(9)}  ${item.cacheControl}`);
            uploaded.push(item);
            continue;
        }

        await client.send(
            new PutObjectCommand({
                Bucket: config.bucket,
                Key: item.key,
                Body: fs.readFileSync(item.file),
                ContentType: item.contentType,
                CacheControl: item.cacheControl,
            }),
        );
        console.log(`  + ${label.padEnd(46)} ${formatBytes(item.size).padStart(9)}  ${item.cacheControl}`);
        uploaded.push(item);
    }

    console.log('');
    console.log(
        opts.dryRun
            ? `Dry run: ${uploaded.length} to upload, ${skipped.length} unchanged (nothing written)`
            : `Done: ${uploaded.length} uploaded, ${skipped.length} unchanged`,
    );

    if (!hasRootManifest && !opts.dryRun) {
        console.log(
            'Pre-release published without touching the root latest.json: installed agents stay put.',
        );
    }

    // Post-upload check: every object must be readable with the expected size.
    if (opts.verify && !opts.dryRun) {
        const wrong = [];
        for (const item of uploads) {
            const size = await headSize(client, config.bucket, item.key);
            if (size !== item.size) wrong.push(`${item.key} (expected ${item.size}, got ${size})`);
        }
        if (wrong.length > 0) {
            throw new Error(`Post-upload check failed:\n  ${wrong.join('\n  ')}`);
        }
        console.log(`Verified ${uploads.length} object(s) with HeadObject.`);
    }

    const base = publicBaseUrl(opts);
    if (base) {
        console.log('');
        console.log('Public URLs:');
        for (const item of uploads) {
            if (item.key === opts.installKey) continue;
            const relative = item.key.startsWith(`${opts.prefix}/`)
                ? item.key.slice(opts.prefix.length + 1)
                : item.key;
            console.log(`  ${base}/${relative}`);
        }
        if (opts.uploadInstaller && opts.installKey) {
            console.log(`  ${base.replace(/\/probe$/, '')}/${opts.installKey}`);
        }
        console.log('');
        console.log(`Verify with: node probes/agent/scripts/verify-release.js --base-url ${base}`);
    }

    return { uploaded, skipped };
}

async function main(argv) {
    const opts = parseArgs(argv);
    if (opts.help) {
        console.log(HELP);
        return;
    }

    const env = { ...loadEnvFile(opts.envFile), ...process.env };
    const config = resolveConfig(opts, env);

    if (opts.dryRun) {
        // A dry run must work without valid credentials.
        config.accessKeyId = config.accessKeyId || 'dry-run';
        config.secretAccessKey = config.secretAccessKey || 'dry-run';
    }

    await publish(opts, config);
}

main(process.argv.slice(2)).catch((err) => {
    console.error(`publish-release: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
});
