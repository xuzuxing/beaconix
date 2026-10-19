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
const DEFAULT_RELEASES_DIR = path.join(REPO_ROOT, 'probes', 'releases');
const DEFAULT_BASE_URL = 'https://get.beaconix.app/probe';
const DEFAULT_INSTALL_URL = 'https://get.beaconix.app/install.sh';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Top-level payload entries that ship to probe hosts. */
const PAYLOAD_ENTRIES = ['index.js', 'bin', 'src', 'functions', 'install', 'package.json'];
const VERSION_HISTORY_NAME = 'version.json';
const LAYOUTS = ['versioned', 'flat'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', '.git']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'package-lock.json']);

const HELP = `Build the Beacon probe-agent release artifacts.

Usage:
  node probes/agent/scripts/build-release.js [options]

Options:
  --out <dir>        Output directory (default: probes/agent/dist)
  --base-url <url>   Public base URL of the published tarballs
  --install-url <u>  Installer URL written into latest.json
  --bump <part>      Auto-increment package.json: patch (default), minor, major
  --no-bump          Keep the current package.json version as-is
  --version <x.y.z>  Set an explicit version instead of bumping
  --releases-dir <d> Release archive directory (default: probes/releases)
  --no-archive       Record history but do not copy artifacts into releases/
  --layout <name>    versioned (default): dist/<version>/…, flat: everything at the root
  --compat-flat      Also publish a flat beaconix-probe-<version>.tar.gz copy
  --no-compat-flat   Do not publish the flat compatibility copy
  --no-scf           Do not build the Tencent SCF zip
  --scf-only         Only build the Tencent SCF zip (other artifacts untouched)
  --latest           Always publish the "latest" alias and latest.json
  --no-latest        Never publish them (default: stable versions only)
  --require-clean    Fail when probes/agent has uncommitted changes
  --no-verify        Skip the post-build archive verification
  -h, --help         Show this help

The version lives in probes/agent/package.json — the same file
src/version.js requires at runtime. "pack" bumps it by default; "--scf-only"
keeps it unless --bump/--version is given explicitly. Each release is archived
under probes/releases/<version>/ and indexed in probes/releases/version.json.

With --layout versioned (default) the output directory mirrors the download
root that install.sh and the container entrypoint expect:

  <out>/<version>/beaconix-probe-<version>.tar.gz
  <out>/<version>/beaconix-probe-scf-<version>.zip
  <out>/<version>/latest.json          manifest describing that version
  <out>/<version>/SHA256SUMS
  <out>/latest.json                    pointer to the newest stable version
  <out>/version.json                   release history
  <out>/beaconix-probe-latest.tar.gz   alias, only used when the manifest is down
  <out>/install.sh                     uploaded to the bucket root
  <out>/beaconix-probe-<version>.tar.gz  flat compatibility copy (--compat-flat)`;

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
        releasesDir: DEFAULT_RELEASES_DIR,
        baseUrl: DEFAULT_BASE_URL,
        installUrl: DEFAULT_INSTALL_URL,
        includeScf: true,
        scfOnly: false,
        latest: 'auto',
        bump: 'patch',
        bumpExplicit: false,
        version: undefined,
        archive: true,
        layout: 'versioned',
        compatFlat: true,
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
        } else if (arg === '--bump') {
            opts.bump = requireValue(argv, ++i, arg);
            if (!['patch', 'minor', 'major'].includes(opts.bump)) {
                throw new Error('--bump must be patch, minor or major');
            }
            opts.bumpExplicit = true;
        } else if (arg === '--no-bump') {
            opts.bump = 'none';
            opts.bumpExplicit = true;
        } else if (arg === '--version') {
            opts.version = requireValue(argv, ++i, arg);
            opts.bumpExplicit = true;
        } else if (arg === '--releases-dir') {
            opts.releasesDir = path.resolve(requireValue(argv, ++i, arg));
        } else if (arg === '--no-archive') {
            opts.archive = false;
        } else if (arg === '--layout') {
            opts.layout = requireValue(argv, ++i, arg);
            if (!LAYOUTS.includes(opts.layout)) {
                throw new Error(`--layout must be ${LAYOUTS.join(' or ')}`);
            }
        } else if (arg === '--compat-flat') {
            opts.compatFlat = true;
        } else if (arg === '--no-compat-flat') {
            opts.compatFlat = false;
        } else if (arg === '--no-scf') {
            opts.includeScf = false;
        } else if (arg === '--scf-only') {
            opts.scfOnly = true;
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

    // In the flat layout the versioned tarball already lives at the root, so a
    // separate compatibility copy would just duplicate the same bytes.
    if (opts.layout === 'flat') opts.compatFlat = false;

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

function verifyInstaller(opts) {
    const installerPath = path.join(AGENT_DIR, 'install', 'install.sh');
    const script = fs.readFileSync(installerPath, 'utf8');
    // `<base>/<version>/beaconix-probe-<version>.tar.gz`
    const versionedPattern =
        /\/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/beaconix-probe-\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\.tar\.gz/;
    // `<base>/beaconix-probe-<version>.tar.gz` (legacy flat layout only)
    const flatPattern =
        /beaconix-probe-\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\.tar\.gz/;

    if (opts.layout === 'versioned') {
        if (!versionedPattern.test(script)) {
            throw new Error(
                'install/install.sh no longer downloads `<base>/<version>/beaconix-probe-<version>.tar.gz`; ' +
                    'update this script and the release docs before publishing',
            );
        }
    } else {
        if (!flatPattern.test(script)) {
            throw new Error(
                'install/install.sh does not download `beaconix-probe-<version>.tar.gz`; ' +
                    'pass --layout versioned or update the installer',
            );
        }
        // The installer tries `<base>/<version>/` first and falls back to these
        // flat files, so a flat release still installs — it just skips the
        // immutable per-version directory.
        console.warn(
            'warning: --layout flat publishes without <version>/ directories; ' +
                'installers try the versioned URL first and fall back to the flat copy',
        );
    }
    if (!/latest\.json/.test(script)) {
        console.warn(
            'warning: install/install.sh does not resolve latest.json; a cached ' +
                '`latest` alias can pin new installs to an old build',
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

/** Directory holding a version's immutable artifacts inside the output root. */
function versionOutDir(opts, version) {
    return opts.layout === 'versioned'
        ? path.join(opts.outDir, version)
        : opts.outDir;
}

/** Artifact path relative to the download root: `2.1.2/…` or just `…`. */
function releasePath(opts, version, name) {
    return opts.layout === 'versioned' ? `${version}/${name}` : name;
}

function bumpSemver(version, part) {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!match) throw new Error(`Cannot bump invalid version: ${version}`);

    let major = Number(match[1]);
    let minor = Number(match[2]);
    let patch = Number(match[3]);

    if (part === 'major') {
        major += 1;
        minor = 0;
        patch = 0;
    } else if (part === 'minor') {
        minor += 1;
        patch = 0;
    } else {
        patch += 1;
    }

    return `${major}.${minor}.${patch}`;
}

function writePackageVersion(version) {
    const pkgPath = path.join(AGENT_DIR, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.version = version;
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 4)}\n`);
    PKG.version = version;
}

function resolveVersion(opts) {
    if (opts.version) {
        if (!SEMVER.test(opts.version)) {
            throw new Error(`Invalid --version value: ${opts.version}`);
        }
        writePackageVersion(opts.version);
        return opts.version;
    }

    // `--scf-only` repackages the current version unless a bump is explicit.
    const shouldBump =
        opts.bump !== 'none' && (!opts.scfOnly || opts.bumpExplicit);
    if (!shouldBump) return PKG.version;

    const next = bumpSemver(PKG.version, opts.bump);
    writePackageVersion(next);
    return next;
}

function loadHistory(opts) {
    const fromReleases = readVersionHistory(opts.releasesDir);
    if (fromReleases.versions.length > 0) return fromReleases;
    return readVersionHistory(opts.outDir);
}

function writeHistories(opts, history) {
    fs.mkdirSync(opts.releasesDir, { recursive: true });
    writeVersionHistory(opts.releasesDir, history);
    writeVersionHistory(opts.outDir, history);
}

function archiveRelease(opts, version, files) {
    if (!opts.archive) return null;

    const dir = path.join(opts.releasesDir, version);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of files) {
        // Artifacts normally live in the version directory; `{ source, name }`
        // covers the ones published at the download root (install.sh, alias).
        const source =
            typeof file === 'string'
                ? path.join(versionOutDir(opts, version), file)
                : file.source;
        const name = typeof file === 'string' ? file : file.name;
        if (fs.existsSync(source)) {
            fs.copyFileSync(source, path.join(dir, name));
        }
    }
    return dir;
}

function archiveScfRelease(opts, version, zipName) {
    if (!opts.archive) return null;

    const dir = path.join(opts.releasesDir, version);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(
        path.join(versionOutDir(opts, version), zipName),
        path.join(dir, zipName),
    );
    fs.copyFileSync(
        path.join(opts.outDir, VERSION_HISTORY_NAME),
        path.join(dir, VERSION_HISTORY_NAME),
    );
    return dir;
}

function utcTimestamp() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function readVersionHistory(dir) {
    try {
        const parsed = JSON.parse(
            fs.readFileSync(path.join(dir, VERSION_HISTORY_NAME), 'utf8'),
        );
        return {
            updatedAt:
                typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
            versions: Array.isArray(parsed.versions) ? parsed.versions : [],
        };
    } catch {
        return { updatedAt: null, versions: [] };
    }
}

function writeVersionHistory(dir, history) {
    fs.writeFileSync(
        path.join(dir, VERSION_HISTORY_NAME),
        `${JSON.stringify(history, null, 4)}\n`,
    );
}

/** Newest first, one entry per version (a rebuild replaces its entry). */
function recordVersion(history, entry) {
    return {
        updatedAt: utcTimestamp(),
        versions: [
            entry,
            ...history.versions.filter((item) => item.version !== entry.version),
        ],
    };
}

function resetOutDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    // Clear the contents instead of removing the directory itself: on Windows a
    // lingering handle on the directory makes rmSync(dir) fail with EPERM.
    for (const name of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, name), {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
        });
    }
}

function isScfEntry(entry) {
    return (
        entry.name === 'index.js' ||
        entry.name === 'package.json' ||
        entry.name === 'RELEASE.json' ||
        entry.name.startsWith('src/') ||
        entry.name === 'functions/scf.js'
    );
}

function scfEntriesFrom(entries) {
    return entries.filter(isScfEntry);
}

function buildScfArchive(entries, epochSeconds, verify) {
    const scfEntries = scfEntriesFrom(entries);
    const zip = buildZip(scfEntries, epochSeconds);
    if (verify) {
        const names = verifyZip(zip);
        if (!names.includes('index.js')) {
            throw new Error('SCF zip is missing the root index.js entry');
        }
    }
    return { zip, scfEntries };
}

function buildScfOnly(opts, entries, source, version, previousVersion) {
    if (!opts.includeScf) {
        throw new Error('--scf-only conflicts with --no-scf');
    }

    const { zip, scfEntries } = buildScfArchive(
        entries,
        source.epochSeconds,
        opts.verify,
    );

    const outDir = versionOutDir(opts, version);
    fs.mkdirSync(outDir, { recursive: true });
    const zipName = `beaconix-probe-scf-${version}.zip`;
    fs.writeFileSync(path.join(outDir, zipName), zip);

    const history = loadHistory(opts);
    const scf = {
        tarball: releasePath(opts, version, zipName),
        handler: 'index.main',
        sha256: sha256(zip),
        size: zip.length,
    };
    const existing = history.versions.find((item) => item.version === version);
    const entry = existing
        ? { ...existing, scf }
        : { version, releasedAt: utcTimestamp(), scf };
    const updatedHistory = recordVersion(history, entry);
    writeHistories(opts, updatedHistory);
    const archiveDir = archiveScfRelease(opts, version, zipName);

    return {
        scfOnly: true,
        version,
        previousVersion,
        layout: opts.layout,
        zipName,
        zipRel: scf.tarball,
        zipPath: path.join(outDir, zipName),
        zipSize: zip.length,
        zipSha: scf.sha256,
        entries: scfEntries.length,
        historyCount: updatedHistory.versions.length,
        releasesDir: opts.releasesDir,
        archiveDir,
        outDir: opts.outDir,
    };
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

    const previousVersion = PKG.version;
    const version = resolveVersion(opts);
    const source = readSourceMeta();
    const entries = buildEntries(source);

    if (opts.scfOnly) {
        return buildScfOnly(opts, entries, source, version, previousVersion);
    }

    const tarName = `beaconix-probe-${version}.tar.gz`;
    const latestTarName = 'beaconix-probe-latest.tar.gz';
    const zipName = `beaconix-probe-scf-${version}.zip`;
    const publishLatestAlias = publishLatest(opts);
    const previousHistory = loadHistory(opts);

    resetOutDir(opts.outDir);

    // Versioned layout: immutable artifacts live under <out>/<version>/, while
    // the moving pointers (latest.json, version.json, the alias and install.sh)
    // stay at the root so each can be served with its own cache policy.
    const outVersionDir = versionOutDir(opts, version);
    fs.mkdirSync(outVersionDir, { recursive: true });

    const tarball = zlib.gzipSync(buildTar(entries, source.epochSeconds), {
        level: 9,
    });
    const tarPath = path.join(outVersionDir, tarName);
    fs.writeFileSync(tarPath, tarball);

    const tarRel = releasePath(opts, version, tarName);
    const artifacts = [{ name: tarRel, size: tarball.length }];

    if (publishLatestAlias) {
        const aliasPath = path.join(opts.outDir, latestTarName);
        fs.writeFileSync(aliasPath, tarball);
        artifacts.push({ name: latestTarName, size: tarball.length });
    }

    if (opts.compatFlat) {
        // Installers cached by a CDN or by the user still ask for the flat URL.
        fs.writeFileSync(path.join(opts.outDir, tarName), tarball);
        artifacts.push({ name: `${tarName} (compat)`, size: tarball.length });
    }

    let zipInfo;
    if (opts.includeScf) {
        const { zip, scfEntries } = buildScfArchive(
            entries,
            source.epochSeconds,
            opts.verify,
        );
        fs.writeFileSync(path.join(outVersionDir, zipName), zip);
        zipInfo = {
            name: zipName,
            size: zip.length,
            sha256: sha256(zip),
            entries: scfEntries.length,
        };
        artifacts.push({
            name: releasePath(opts, version, zipName),
            size: zip.length,
        });
    }

    const installerSource = path.join(AGENT_DIR, 'install', 'install.sh');
    verifyInstaller(opts);
    fs.copyFileSync(installerSource, path.join(opts.outDir, 'install.sh'));
    artifacts.push({
        name: 'install.sh',
        size: fs.statSync(installerSource).size,
    });

    if (opts.verify) {
        verifyTarball(tarPath, version);
    }

    const tarSha = sha256(tarball);
    const zipRel = zipInfo ? releasePath(opts, version, zipName) : null;
    const manifest = {
        name: PKG.name,
        version,
        channel: publishLatestAlias ? 'latest' : 'prerelease',
        layout: opts.layout,
        tarball: `${opts.baseUrl}/${tarRel}`,
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
            tarball: `${opts.baseUrl}/${zipRel}`,
            handler: 'index.main',
        };
    }

    const manifestJson = `${JSON.stringify(manifest, null, 4)}\n`;
    // The per-version manifest describes that version only (never "current"),
    // so pre-releases get one too; installers read the root manifest.
    fs.writeFileSync(path.join(outVersionDir, 'latest.json'), manifestJson);
    if (publishLatestAlias) {
        // A prerelease must never ship a root latest.json: syncing the directory
        // would silently point every installed agent at the pre-release.
        fs.writeFileSync(path.join(opts.outDir, 'latest.json'), manifestJson);
    }

    // Version-local checksums: `sha256sum -c` works from inside <version>/.
    const versionSums = [`${tarSha}  ${tarName}`];
    if (zipInfo) versionSums.push(`${zipInfo.sha256}  ${zipName}`);
    fs.writeFileSync(
        path.join(outVersionDir, 'SHA256SUMS'),
        `${versionSums.join('\n')}\n`,
    );

    // Root checksums carry paths relative to the download root, so a single
    // `sha256sum -c` verifies a mirrored directory in either layout.
    const sums = [
        `${tarSha}  ${tarRel}`,
        `${sha256(fs.readFileSync(path.join(opts.outDir, 'install.sh')))}  install.sh`,
    ];
    if (publishLatestAlias) sums.push(`${tarSha}  ${latestTarName}`);
    if (zipInfo) sums.push(`${zipInfo.sha256}  ${zipRel}`);
    if (opts.compatFlat) sums.push(`${tarSha}  ${tarName}`);
    fs.writeFileSync(
        path.join(opts.outDir, 'SHA256SUMS'),
        `${sums.join('\n')}\n`,
    );

    const previousEntry = previousHistory.versions.find(
        (item) => item.version === version,
    );
    const historyEntry = {
        version,
        releasedAt: previousEntry?.releasedAt || utcTimestamp(),
        channel: manifest.channel,
        commit: source.commit,
        sourceDate: source.sourceDate,
        tarball: tarRel,
        sha256: tarSha,
        size: tarball.length,
    };
    if (zipInfo) {
        historyEntry.scf = {
            tarball: zipRel,
            handler: 'index.main',
            sha256: zipInfo.sha256,
            size: zipInfo.size,
        };
    }
    const updatedHistory = recordVersion(previousHistory, historyEntry);
    writeHistories(opts, updatedHistory);
    const archiveDir = archiveRelease(opts, version, [
        tarName,
        ...(zipInfo ? [zipName] : []),
        'latest.json',
        'SHA256SUMS',
        {
            source: path.join(opts.outDir, 'install.sh'),
            name: 'install.sh',
        },
        {
            source: path.join(opts.outDir, VERSION_HISTORY_NAME),
            name: VERSION_HISTORY_NAME,
        },
        ...(publishLatestAlias
            ? [
                  {
                      source: path.join(opts.outDir, latestTarName),
                      name: latestTarName,
                  },
              ]
            : []),
    ]);

    return {
        version,
        previousVersion,
        layout: opts.layout,
        compatFlat: opts.compatFlat,
        versionDir: opts.layout === 'versioned' ? version : null,
        tarName,
        tarRel,
        zipRel,
        latestTarName: publishLatestAlias ? latestTarName : null,
        zipName: zipInfo ? zipInfo.name : null,
        manifest,
        artifacts,
        outDir: opts.outDir,
        releasesDir: opts.releasesDir,
        archiveDir,
        baseUrl: opts.baseUrl,
        installUrl: opts.installUrl,
        source,
        historyCount: updatedHistory.versions.length,
    };
}

function printSummary(result) {
    if (result.scfOnly) {
        console.log(`Beacon probe agent SCF package ${result.version}`);
        if (result.version !== result.previousVersion) {
            console.log(`Version: ${result.previousVersion} -> ${result.version}`);
        }
        console.log(`Output: ${result.outDir}`);
        if (result.archiveDir) {
            console.log(`Archive: ${result.archiveDir}`);
        }
        console.log('');
        console.log(
            `  ${(result.zipRel || result.zipName).padEnd(36)} ${formatBytes(result.zipSize)}`,
        );
        console.log(`  sha256 ${result.zipSha}`);
        console.log(`  history versions: ${result.historyCount}`);
        console.log('');
        console.log('Tencent SCF console:');
        console.log('  Runtime:  Node.js 18 / 20 / 22');
        console.log('  Handler:  index.main');
        console.log(
            '  Env:      BEACON_API_URL, PROBE_KEY, PROBE_TOKEN, PROBE_INTERVAL_SECONDS',
        );
        console.log(
            '  Trigger:  timer period must equal PROBE_INTERVAL_SECONDS',
        );
        return;
    }

    console.log(
        `Beacon probe agent ${result.version} (${result.manifest.channel}, ${result.source.commit})`,
    );
    if (result.version !== result.previousVersion) {
        console.log(`Version: ${result.previousVersion} -> ${result.version}`);
    }
    console.log(`Layout: ${result.layout}`);
    console.log(`Output: ${result.outDir}`);
    if (result.archiveDir) {
        console.log(`Archive: ${result.archiveDir}`);
    }
    console.log('');

    for (const artifact of result.artifacts) {
        console.log(`  ${artifact.name.padEnd(36)} ${formatBytes(artifact.size)}`);
    }
    if (result.latestTarName) {
        console.log('  latest.json                          pointer to this version');
    } else {
        console.log(
            '  (pre-release: no root latest.json / latest alias — installed agents stay put)',
        );
    }
    if (result.versionDir) {
        console.log(
            `  ${`${result.versionDir}/SHA256SUMS`.padEnd(36)} version-local checksums`,
        );
        console.log(
            `  ${`${result.versionDir}/latest.json`.padEnd(36)} manifest describing this version`,
        );
    }
    console.log('  SHA256SUMS                           root checksums (paths from the root)');
    console.log(
        `  ${VERSION_HISTORY_NAME.padEnd(36)} history (${result.historyCount} version(s))`,
    );
    console.log('');
    console.log('Upload the output directory as-is so that it resolves as:');
    console.log(
        `  rclone copy ${result.outDir}/ r2:<bucket>/probe/`,
    );
    console.log(
        `  rclone copy ${result.outDir}/install.sh r2:<bucket>/`,
    );
    console.log('');
    console.log(`  ${result.baseUrl}/${result.tarRel}`);
    if (result.zipRel) {
        console.log(`  ${result.baseUrl}/${result.zipRel}`);
    }
    if (result.latestTarName) {
        console.log(`  ${result.baseUrl}/${result.latestTarName}`);
        console.log(`  ${result.baseUrl}/latest.json`);
    }
    console.log(`  ${result.baseUrl}/${VERSION_HISTORY_NAME}`);
    console.log(`  ${result.installUrl}`);
    console.log('');
    console.log('Cache headers:');
    console.log(
        `  ${result.baseUrl}/${result.versionDir || '<version>'}/**  immutable (max-age=31536000)`,
    );
    console.log('  latest.json / version.json / install.sh        max-age=60');
    console.log('');
    console.log('Upload order: version artifacts -> <version>/SHA256SUMS -> version.json');
    console.log('              -> latest.json -> latest alias -> install.sh');
    console.log('');
    console.log('Verify a published release with:');
    console.log(
        `  curl -fsSL ${result.baseUrl}/SHA256SUMS | sha256sum -c --ignore-missing`,
    );
    console.log('  pnpm probe:verify');
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
