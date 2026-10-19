'use strict';

/** self-update against a mock release manifest. */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'probes', 'agent', 'bin', 'beaconix-probe.js');
const PKG = require(path.join(REPO_ROOT, 'probes', 'agent', 'package.json'));

function runCli(args, home, extraEnv = {}) {
    return new Promise((resolve, reject) => {
        const env = {
            ...process.env,
            BEACON_HOME: home,
            BEACON_LOG_DIR: path.join(home, 'logs'),
            BEACON_RUN_DIR: path.join(home, 'run'),
            ...extraEnv,
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

function startMock(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

test('self-update --check reports an available update', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beaconix-update-'));
    const server = await startMock((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url.startsWith('/latest.json')) {
            res.end(
                JSON.stringify({
                    version: '9.9.9',
                    installUrl: 'https://get.beaconix.app/install.sh',
                }),
            );
            return;
        }
        res.statusCode = 404;
        res.end('{}');
    });

    const port = server.address().port;
    try {
        const result = await runCli(['self-update', '--check'], home, {
            BEACON_DOWNLOAD_BASE: `http://127.0.0.1:${port}`,
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /An update is available/);
        assert.match(result.stdout, /9\.9\.9/);
    } finally {
        server.close();
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('self-update --check reports up to date when versions match', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beaconix-update-'));
    const server = await startMock((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: PKG.version }));
    });

    const port = server.address().port;
    try {
        const result = await runCli(['self-update', '--check'], home, {
            BEACON_DOWNLOAD_BASE: `http://127.0.0.1:${port}`,
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /Up to date/);
    } finally {
        server.close();
        fs.rmSync(home, { recursive: true, force: true });
    }
});
