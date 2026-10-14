'use strict';

/**
 * Service lifecycle test against the pidfile backend (the fallback used when
 * no systemd/launchd unit is installed, which is the case on the CI/dev host).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'probes', 'agent', 'bin', 'beaconix-probe.js');

const CONN = [
    '--api-url',
    'http://127.0.0.1:9/api', // nothing listens here; the probe just retries
    '--key',
    'probe-x',
    '--token',
    'tnt-x',
    '--allow-insecure',
];

function runCli(args, home) {
    return new Promise((resolve, reject) => {
        const env = {
            ...process.env,
            BEACON_HOME: home,
            BEACON_LOG_DIR: path.join(home, 'logs'),
            BEACON_RUN_DIR: path.join(home, 'run'),
        };
        for (const key of [
            'PROBE_CONFIG',
            'PROBE_KEY',
            'PROBE_TOKEN',
            'PROBE_SECRET',
            'BEACON_API_URL',
        ]) {
            delete env[key];
        }

        const child = spawn(process.execPath, [CLI, ...args], { env });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));

        const killer = setTimeout(() => child.kill('SIGKILL'), 20000);
        child.on('error', (err) => {
            clearTimeout(killer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(killer);
            resolve({ status: code, stdout, stderr });
        });
    });
}

function readPid(pidPath) {
    try {
        const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
        return null;
    }
}

test('start/status/restart/stop drive the pidfile backend', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beaconix-service-'));
    const pidPath = path.join(home, 'run', 'probe.pid');

    try {
        const start = await runCli(['start', ...CONN], home);
        assert.equal(start.status, 0, start.stdout + start.stderr);

        const pid1 = readPid(pidPath);
        assert.ok(pid1, `pidfile not written: ${start.stdout}${start.stderr}`);

        const status1 = await runCli(['status'], home);
        assert.match(status1.stdout, /running \(pid/);

        const restart = await runCli(['restart', ...CONN], home);
        assert.equal(restart.status, 0, restart.stdout + restart.stderr);
        const pid2 = readPid(pidPath);
        assert.ok(pid2, 'pidfile missing after restart');
        assert.notEqual(pid2, pid1);

        const stop = await runCli(['stop'], home);
        assert.equal(stop.status, 0, stop.stdout + stop.stderr);
        assert.equal(fs.existsSync(pidPath), false);

        const status2 = await runCli(['status'], home);
        assert.match(status2.stdout, /not running/);
    } finally {
        // Never leave a stray background probe behind.
        await runCli(['stop'], home).catch(() => undefined);
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('start refuses to run without credentials', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beaconix-service-'));
    try {
        const result = await runCli(
            ['start', '--api-url', 'https://api.example.com/api'],
            home,
        );
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Missing probe credential/);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
