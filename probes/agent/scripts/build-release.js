#!/usr/bin/env node
'use strict';

/**
 * Build the publishable probe-agent artifacts.
 *
 * The output layout is dictated by the two consumers that already exist in this
 * repository, so this script must never invent new file names:
 *
 *   install/install.sh      downloads `<base>/beaconix-probe-<version>.tar.gz`
 *                           (and `<base>/beaconix-probe-latest.tar.gz` by
 *                           default) and extracts it straight into
 *                           /opt/beaconix-probe, so the archive root must be
 *                           `bin/`, `src/`, ...
 *   src/commands/self-update.js  reads `<base>/latest.json` for `version` and
 *                           `installUrl`.
 *
 * Zero runtime dependencies on purpose: the agent itself is dependency-free, and
 * this script has to run on the maintainers' Windows/macOS/Linux machines as
 * well as in CI without a package install step.
 *
 * Usage:
 *   node probes/agent/scripts/build-release.js [options]
 *
 * Options:
 *   --out <dir>        Output directory (default: probes/agent/dist)
 *   --base-url <url>   Where the tarballs are published (default:
 *                      https://get.beaconix.app/probe)
 *   --install-url <u>  Installer URL written into latest.json
 *   --no-scf           Do not build the Tencent SCF zip
 *   --latest           Always publish the `latest` alias + latest.json
 *   --no-latest        Never publish the `latest` alias + latest.json
 *                      (default: only for stable versions, not for -rc/-beta)
 *   --require-clean    Fail when probes/agent has uncommitted changes
 *   --no-verify        Skip the post-build archive verification
 *   -h, --help         Show this help
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const AGENT_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(AGENT_DIR, '..', '..');
const PKG = require(path.join(AGENT_DIR, 'package.json'));

const DEFAULT_OUT_DIR = path.join(AGENT_DIR, 'dist');
const DEFAULT_BASE_URL = 'https://get.beaconix.app/probe';
const DEFAULT_INSTALL_URL = 'https://get.beaconix.app/install.sh';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Top-level payload entries that ship to probe hosts. */
const PAYLOAD_ENTRIES = ['bin', 'src', 'functions', 'install', 'package.json'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', '.git']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'package-lock.json']);

const HELP = `Build the Beacon probe-agent release artifacts.

Usage:
  node probes/agent/scripts/build-release.js [options]

Options:
  --out <dir>        Output directory (default: probes/agent/dist)
  --base-url <url>   Public base URL of the published tarballs
  --install-url <u>  Installer URL written into latest.json
  --no-scf           Do not build the Tencent SCF zip
  --latest           Always publish the "latest" alias and latest.json
  --no-latest        Never publish them (default: stable versions only)
  --require-clean    Fail when probes/agent has uncommitted changes
  --no-verify        Skip the post-build archive verification
  -h, --help         Show this help

The version always comes from probes/agent/package.json — the same file
src/version.js requires at runtime.`;

function stripTrailingSlash(value) {
    return String(value).replace(/\/+$/, '');
}

function requireValue(argv, index, option) {
    if (index >= argv.length) {
        throw new Error(`${option} requires a value`);
    }
    return argv[index];
}

function parseArgs(argv) {
    const opts = {
        outDir: DEFAULT_OUT_DIR,
        baseUrl: DEFAULT_BASE_URL,
        installUrl: DEFAULT_INSTALL_URL,
        includeScf: true,
        latest: 'auto',
        requireClean: false,
        verify: true,
        help: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '-h' || arg === '--help') {
            opts.help = true;
        } else if (arg === '--out') {
            opts.outDir = path.resolve(requireValue(argv, ++i, arg));
        } else if (arg === '--base-url') {
            opts.baseUrl = stripTrailingSlash(requireValue(argv, ++i, arg));
        } else if (arg === '--install-url') {
            opts.installUrl = requireValue(argv, ++i, arg);
        } else if (arg === '--no-scf') {
            opts.includeScf = false;
        } else if (arg === '--latest') {
            opts.latest = 'always';
        } else if (arg === '--no-latest') {
            opts.latest = 'never';
        } else if (arg === '--require-clean') {
            opts.requireClean = true;
        } else if (arg === '--no-verify') {
            opts.verify = false;
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }

    return opts;
}

function git(args, fallback) {
    try {
        return execFileSync('git', args, {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return fallback;
    }
}

function readSourceMeta() {
    const commit = git(['rev-parse', '--short', 'HEAD'], 'unknown');
    const sourceDate = git(['log', '-1', '--format=%cI'], '');
    const epochSeconds = sourceDate
        ? Math.floor(new Date(sourceDate).getTime() / 1000)
        : Math.floor(Date.now() / 1000);

    return {
        commit,
        sourceDate: sourceDate || new Date(epochSeconds * 1000).toISOString(),
        epochSeconds,
    };
}

function assertCleanIfRequested(opts) {
    if (!opts.requireClean) return;

    const dirty = git(['status', '--porcelain', '--', 'probes/agent'], '');
    if (dirty) {
        throw new Error(
            'probes/agent has uncommitted changes; commit them or drop --require-clean:\n' +
                dirty,
        );
    }
}

function assertSafeOutDir(outDir) {
    const resolved = path.resolve(outDir);
    const forbidden = new Set([
        path.parse(resolved).root,
        REPO_ROOT,
        AGENT_DIR,
        path.join(REPO_ROOT, 'src'),
    ]);

    if (forbidden.has(resolved)) {
        throw new Error(`Refusing to clean the output directory ${resolved}`);
    }

    // `--out` is deleted before every build; refuse filesystem roots and
    // one-level directories such as /tmp or C:\Users.
    const relative = path.relative(path.parse(resolved).root, resolved);
    if (relative.split(path.sep).filter(Boolean).length < 2) {
        throw new Error(
            `Refusing to clean ${resolved}; point --out at a dedicated directory`,
        );
    }
}

function modeFor(relativePath) {
    if (relativePath.startsWith('bin/')) return 0o755;
    if (relativePath.endsWith('.sh')) return 0o755;
    return 0o644;
}

function collectFiles(absDir, prefix, out) {
    for (const name of fs.readdirSync(absDir).sort()) {
        const abs = path.join(absDir, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        const stat = fs.statSync(abs);

        if (stat.isDirectory()) {
            if (SKIP_DIRS.has(name)) continue;
            collectFiles(abs, rel, out);
        } else if (stat.isFile()) {
            if (SKIP_FILES.has(name)) continue;
            out.push({
                name: rel,
                data: fs.readFileSync(abs),
                mode: modeFor(rel),
            });
        }
    }
}

/** Payload shipped to probe hosts (and the source of the SCF zip). */
function buildEntries(source) {
    const entries = [];

    for (const entry of PAYLOAD_ENTRIES) {
        const abs = path.join(AGENT_DIR, entry);
        if (!fs.existsSync(abs)) {
            throw new Error(`Missing payload entry: ${abs}`);
        }
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
            collectFiles(abs, entry, entries);
        } else {
            entries.push({
                name: entry,
                data: fs.readFileSync(abs),
                mode: modeFor(entry),
            });
        }
    }

    const release = {
        name: PKG.name,
        version: PKG.version,
        commit: source.commit,
        sourceDate: source.sourceDate,
        engines: PKG.engines || {},
        entry: 'bin/beaconix-probe.js',
    };
    entries.push({
        name: 'RELEASE.json',
        data: Buffer.from(`${JSON.stringify(release, null, 2)}\n`, 'utf8'),
        mode: 0o644,
    });

    return entries.sort((a, b) => (a.name < b.name ? -1 : 1));
}

function octal(value, width) {
    const text = value.toString(8);
    if (text.length > width - 1) {
        throw new Error(`Value ${value} does not fit in ${width} octal bytes`);
    }
    return `${text.padStart(width - 1, '0')}\0`;
}

function tarHeader(name, size, mode, mtime) {
    let baseName = name;
    let prefix = '';

    if (Buffer.byteLength(name, 'utf8') > 100) {
        const slash = name.lastIndexOf('/', 150);
        if (slash <= 0) {
            throw new Error(`Path too long for a ustar archive: ${name}`);
        }
        prefix = name.slice(0, slash);
        baseName = name.slice(slash + 1);
        if (
            Buffer.byteLength(prefix, 'utf8') > 155 ||
            Buffer.byteLength(baseName, 'utf8') > 100
        ) {
            throw new Error(`Path too long for a ustar archive: ${name}`);
        }
    }

    const header = Buffer.alloc(512, 0);
    header.write(baseName, 0, 100, 'utf8');
    header.write(octal(mode, 8), 100, 8, 'utf8'); // mode
    header.write(octal(0, 8), 108, 8, 'utf8'); // uid
    header.write(octal(0, 8), 116, 8, 'utf8'); // gid
    header.write(octal(size, 12), 124, 12, 'utf8');
    header.write(octal(mtime, 12), 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8'); // checksum placeholder
    header.write('0', 156, 1, 'utf8'); // regular file
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write(prefix, 345, 155, 'utf8');

    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(
        `${sum.toString(8).padStart(6, '0')}\0 `,
        148,
        8,
        'ascii',
    );

    return header;
}

function buildTar(entries, epochSeconds) {
    const chunks = [];

    for (const entry of entries) {
        chunks.push(
            tarHeader(entry.name, entry.data.length, entry.mode, epochSeconds),
        );
        chunks.push(entry.data);
        const padding = (512 - (entry.data.length % 512)) % 512;
        if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
    }

    chunks.push(Buffer.alloc(1024, 0));
    return Buffer.concat(chunks);
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let value = i;
        for (let bit = 0; bit < 8; bit += 1) {
            value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[i] = value >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(epochSeconds) {
    const date = new Date(epochSeconds * 1000);
    const year = Math.max(1980, date.getUTCFullYear());
    const time =
        (date.getUTCHours() << 11) |
        (date.getUTCMinutes() << 5) |
        Math.floor(date.getUTCSeconds() / 2);
    const day =
        (((year - 1980) & 0x7f) << 9) |
        ((date.getUTCMonth() + 1) << 5) |
        date.getUTCDate();

    return { time, day };
}

/** Minimal ZIP writer (deflate, no zip64) — enough for an SCF code package. */
function buildZip(entries, epochSeconds) {
    const { time, day } = dosDateTime(epochSeconds);
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBytes = Buffer.from(entry.name, 'utf8');
        const payload = zlib.deflateRawSync(entry.data, { level: 9 });
        const crc = crc32(entry.data);

        const local = Buffer.alloc(30 + nameBytes.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0, 6); // flags
        local.writeUInt16LE(8, 8); // deflate
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(day, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);
        nameBytes.copy(local, 30);

        const central = Buffer.alloc(46 + nameBytes.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4); // version made by
        central.writeUInt16LE(20, 6); // version needed
        central.writeUInt16LE(0, 8); // flags
        central.writeUInt16LE(8, 10); // deflate
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(day, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(payload.length, 20);
        central.writeUInt32LE(entry.data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt16LE(0, 30); // extra
        central.writeUInt16LE(0, 32); // comment
        central.writeUInt16LE(0, 34); // disk
        central.writeUInt16LE(0, 36); // internal attrs
        central.writeUInt32LE(modeFor(entry.name) << 16, 38); // external attrs
        central.writeUInt32LE(offset, 42);
        nameBytes.copy(central, 46);

        locals.push(local, payload);
        centrals.push(central);
        offset += local.length + payload.length;
    }

    const centralDirectory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...locals, centralDirectory, end]);
}

/** Parse the produced zip back and re-check every payload against its CRC. */
function verifyZip(buffer) {
    const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const eocd = buffer.lastIndexOf(eocdSignature);
    if (eocd < 0) throw new Error('zip verification: end of central directory missing');

    const total = buffer.readUInt16LE(eocd + 10);
    const directorySize = buffer.readUInt32LE(eocd + 12);
    const directoryOffset = buffer.readUInt32LE(eocd + 16);
    if (directoryOffset + directorySize > buffer.length) {
        throw new Error('zip verification: central directory is out of bounds');
    }

    const names = [];
    let cursor = directoryOffset;

    for (let index = 0; index < total; index += 1) {
        if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
            throw new Error('zip verification: bad central directory entry');
        }
        const method = buffer.readUInt16LE(cursor + 10);
        const crc = buffer.readUInt32LE(cursor + 16);
        const compressedSize = buffer.readUInt32LE(cursor + 20);
        const uncompressedSize = buffer.readUInt32LE(cursor + 24);
        const nameLength = buffer.readUInt16LE(cursor + 28);
        const extraLength = buffer.readUInt16LE(cursor + 30);
        const commentLength = buffer.readUInt16LE(cursor + 32);
        const localOffset = buffer.readUInt32LE(cursor + 42);
        const name = buffer.toString(
            'utf8',
            cursor + 46,
            cursor + 46 + nameLength,
        );

        if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
            throw new Error(`zip verification: bad local header for ${name}`);
        }
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const raw = buffer.subarray(dataStart, dataStart + compressedSize);
        const content = method === 8 ? zlib.inflateRawSync(raw) : raw;

        if (content.length !== uncompressedSize) {
            throw new Error(`zip verification: size mismatch for ${name}`);
        }
        if (crc32(content) !== crc) {
            throw new Error(`zip verification: checksum mismatch for ${name}`);
        }

        names.push(name);
        cursor += 46 + nameLength + extraLength + commentLength;
    }

    return names;
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function runNodeCheck(jsFiles) {
    for (const file of jsFiles) {
        try {
            execFileSync(process.execPath, ['--check', file], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (err) {
            const stderr = err.stderr ? err.stderr.toString() : err.message;
            throw new Error(`Syntax check failed for ${file}:\n${stderr}`);
        }
    }
}

function verifyTarball(tarPath, expectedVersion) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'beaconix-release-'));
    const extractDir = path.join(temp, 'extract');

    try {
        // GNU tar on Windows reads `D:\...` as a remote `host:path`, so hand it
        // relative names from a working directory instead of absolute paths.
        fs.copyFileSync(tarPath, path.join(temp, 'payload.tar.gz'));
        fs.mkdirSync(extractDir, { recursive: true });

        try {
            execFileSync('tar', ['-xzf', 'payload.tar.gz', '-C', 'extract'], {
                cwd: temp,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (err) {
            if (err.code === 'ENOENT') {
                console.warn(
                    'warning: tar is not available; skipped extraction check',
                );
                return;
            }
            throw new Error(`tar extraction failed: ${err.message}`);
        }

        const entry = path.join(extractDir, 'bin', 'beaconix-probe.js');
        if (!fs.existsSync(entry)) {
            throw new Error('tar verification: bin/beaconix-probe.js is missing');
        }
        if (!fs.existsSync(path.join(extractDir, 'package.json'))) {
            throw new Error('tar verification: package.json is missing');
        }

        const jsFiles = [];
        const walk = (dir) => {
            for (const name of fs.readdirSync(dir)) {
                const abs = path.join(dir, name);
                if (fs.statSync(abs).isDirectory()) walk(abs);
                else if (name.endsWith('.js')) jsFiles.push(abs);
            }
        };
        walk(extractDir);
        runNodeCheck(jsFiles);

        const output = execFileSync(process.execPath, [entry, 'version'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        if (output !== expectedVersion) {
            throw new Error(
                `tar verification: CLI reports ${output}, expected ${expectedVersion}`,
            );
        }
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

function verifyInstaller(installerPath, version) {
    const script = fs.readFileSync(installerPath, 'utf8');
    if (!/beaconix-probe-\$VERSION\.tar\.gz/.test(script)) {
        throw new Error(
            'install/install.sh no longer downloads `beaconix-probe-$VERSION.tar.gz`; ' +
                'update this script and the release docs before publishing',
        );
    }
    if (!/beaconix-probe-latest\.tar\.gz/.test(script) && !/VERSION="latest"/.test(script)) {
        console.warn(
            `warning: install.sh does not reference a ${version} archive name`,
        );
    }
}

function publishLatest(opts) {
    if (opts.latest === 'always') return true;
    if (opts.latest === 'never') return false;
    return !PKG.version.includes('-');
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function build(opts) {
    if (!SEMVER.test(PKG.version)) {
        throw new Error(`Invalid version in package.json: ${PKG.version}`);
    }
    if (!PKG.bin || !PKG.bin['beaconix-probe']) {
        throw new Error('package.json must declare the beaconix-probe bin entry');
    }

    assertCleanIfRequested(opts);
    assertSafeOutDir(opts.outDir);

    const source = readSourceMeta();
    const entries = buildEntries(source);
    const version = PKG.version;
    const tarName = `beaconix-probe-${version}.tar.gz`;
    const latestTarName = 'beaconix-probe-latest.tar.gz';
    const zipName = `beaconix-probe-scf-${version}.zip`;
    const publishLatestAlias = publishLatest(opts);

    fs.rmSync(opts.outDir, { recursive: true, force: true });
    fs.mkdirSync(opts.outDir, { recursive: true });

    const tarball = zlib.gzipSync(buildTar(entries, source.epochSeconds), {
        level: 9,
    });
    const tarPath = path.join(opts.outDir, tarName);
    fs.writeFileSync(tarPath, tarball);

    const artifacts = [{ name: tarName, size: tarball.length }];

    if (publishLatestAlias) {
        const aliasPath = path.join(opts.outDir, latestTarName);
        fs.writeFileSync(aliasPath, tarball);
        artifacts.push({ name: latestTarName, size: tarball.length });
    }

    let zipInfo;
    if (opts.includeScf) {
        const scfEntries = entries.filter(
            (entry) =>
                entry.name === 'package.json' ||
                entry.name === 'RELEASE.json' ||
                entry.name.startsWith('src/') ||
                entry.name === 'functions/scf.js',
        );
        const zip = buildZip(scfEntries, source.epochSeconds);
        if (opts.verify) {
            verifyZip(zip);
        }
        fs.writeFileSync(path.join(opts.outDir, zipName), zip);
        artifacts.push({ name: zipName, size: zip.length });
        zipInfo = { name: zipName, size: zip.length, entries: scfEntries.length };
    }

    const installerSource = path.join(AGENT_DIR, 'install', 'install.sh');
    verifyInstaller(installerSource, version);
    fs.copyFileSync(installerSource, path.join(opts.outDir, 'install.sh'));
    artifacts.push({
        name: 'install.sh',
        size: fs.statSync(installerSource).size,
    });

    if (opts.verify) {
        verifyTarball(tarPath, version);
    }

    const tarSha = sha256(tarball);
    const manifest = {
        name: PKG.name,
        version,
        channel: publishLatestAlias ? 'latest' : 'prerelease',
        tarball: `${opts.baseUrl}/${tarName}`,
        installUrl: opts.installUrl,
        sha256: tarSha,
        engines: PKG.engines || {},
        commit: source.commit,
        sourceDate: source.sourceDate,
    };
    if (publishLatestAlias) {
        manifest.latestTarball = `${opts.baseUrl}/${latestTarName}`;
    }
    if (zipInfo) {
        manifest.scf = {
            tarball: `${opts.baseUrl}/${zipName}`,
            handler: 'functions/scf.main_handler',
        };
    }
    if (publishLatestAlias) {
        // A prerelease must never ship a latest.json: syncing the directory
        // would silently point every installed agent at the pre-release.
        fs.writeFileSync(
            path.join(opts.outDir, 'latest.json'),
            `${JSON.stringify(manifest, null, 4)}\n`,
        );
    }

    const sums = [
        `${sha256(tarball)}  ${tarName}`,
        `${sha256(fs.readFileSync(path.join(opts.outDir, 'install.sh')))}  install.sh`,
    ];
    if (publishLatestAlias) sums.push(`${tarSha}  ${latestTarName}`);
    if (zipInfo) {
        sums.push(
            `${sha256(fs.readFileSync(path.join(opts.outDir, zipName)))}  ${zipName}`,
        );
    }
    fs.writeFileSync(
        path.join(opts.outDir, 'SHA256SUMS'),
        `${sums.join('\n')}\n`,
    );

    return {
        version,
        tarName,
        latestTarName: publishLatestAlias ? latestTarName : null,
        zipName: zipInfo ? zipName : null,
        manifest,
        artifacts,
        outDir: opts.outDir,
        baseUrl: opts.baseUrl,
        installUrl: opts.installUrl,
        source,
    };
}

function printSummary(result) {
    console.log(
        `Beacon probe agent ${result.version} (${result.manifest.channel}, ${result.source.commit})`,
    );
    console.log(`Output: ${result.outDir}`);
    console.log('');

    for (const artifact of result.artifacts) {
        console.log(`  ${artifact.name.padEnd(36)} ${formatBytes(artifact.size)}`);
    }
    if (result.latestTarName) {
        console.log('  latest.json                          publish manifest');
    } else {
        console.log(
            '  (pre-release: no latest.json / latest alias — installed agents stay put)',
        );
    }
    console.log('  SHA256SUMS                           checksums');
    console.log('');
    console.log('Upload all files above so that they resolve as:');
    console.log(`  ${result.baseUrl}/${result.tarName}`);
    if (result.latestTarName) {
        console.log(`  ${result.baseUrl}/${result.latestTarName}`);
    }
    if (result.zipName) {
        console.log(`  ${result.baseUrl}/${result.zipName}`);
    }
    if (result.latestTarName) {
        console.log(`  ${result.baseUrl}/latest.json`);
    }
    console.log(`  ${result.installUrl}`);
    console.log('');
    console.log('Verify a published release with:');
    console.log(
        `  curl -fsSL ${result.baseUrl}/SHA256SUMS | sha256sum -c --ignore-missing`,
    );
}

function main(argv) {
    const opts = parseArgs(argv);
    if (opts.help) {
        console.log(HELP);
        return;
    }

    const result = build(opts);
    printSummary(result);
}

try {
    main(process.argv.slice(2));
} catch (err) {
    console.error(`build-release: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
}
