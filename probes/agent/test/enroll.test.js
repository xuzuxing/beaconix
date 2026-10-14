'use strict';

/**
 * Enrollment end-to-end tests: both registration paths against a mock backend,
 * plus logout. Everything is confined to a temporary BEACON_HOME.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'probes', 'agent', 'bin', 'beaconix-probe.js');

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

function startMock(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('login (device flow) stores credentials once approved, logout removes them', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beaconix-enroll-'));
    let polls = 0;

    const server = await startMock((req, res) => {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
            res.setHeader('content-type', 'application/json');
            if (req.url === '/api/probes/enroll/device') {
                res.end(
                    JSON.stringify({
                        data: {
                            deviceCode: 'dc-1',
                            userCode: 'WDJB-MJHT',
                            verificationUri: 'https://app.test/activate',
                            verificationUriComplete:
                                'https://app.test/activate?code=WDJB-MJHT',
                            expiresIn: 30,
                            interval: 1,
                        },
                    }),
                );
                return;
            }
            if (req.url === '/api/probes/enroll/token') {
                polls += 1;
                const status = polls >= 2 ? 'approved' : 'pending';
                const data =
                    status === 'approved'
                        ? {
                              status,
                              credential: {
                                  probeId: 'probe-abc',
                                  secret: 'tnt-secret',
                              },
                          }
                        : { status };
                res.end(JSON.stringify({ data }));
                return;
            }
            res.statusCode = 404;
            res.end('{}');
        });
    });

    const port = server.address().port;
    try {
        const login = await runCli(
            [
                'login',
                '--no-open',
                '--api-url',
                `http://127.0.0.1:${port}/api`,
                '--allow-insecure',
                '--interval-seconds',
                '30',
            ],
            home,
        );
        assert.equal(login.status, 0, login.stdout + login.stderr);
        assert.ok(polls >= 2, `expected at least two polls, got ${polls}`);

        const credentialPath = path.join(home, 'probe.json');
        const saved = readJson(credentialPath);
        assert.equal(saved.key, 'probe-abc');
        assert.equal(saved.token, 'tnt-secret');
        assert.equal(saved.apiUrl, `http://127.0.0.1:${port}/api`);

        const logout = await runCli(['logout'], home);
        assert.equal(logout.status, 0, logout.stdout + logout.stderr);
        assert.equal(fs.existsSync(credentialPath), false);
    } finally {
        server.close();
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('enroll --enroll-token redeems a one-time token', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beaconix-enroll-'));
    let redeemBody = null;

    const server = await startMock((req, res) => {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
            res.setHeader('content-type', 'application/json');
            if (req.url === '/api/probes/enroll/redeem') {
                redeemBody = JSON.parse(raw);
                res.end(
                    JSON.stringify({
                        data: { probeId: 'probe-xyz', secret: 'tnt-xyz' },
                    }),
                );
                return;
            }
            res.statusCode = 404;
            res.end('{}');
        });
    });

    const port = server.address().port;
    try {
        const result = await runCli(
            [
                'enroll',
                '--enroll-token',
                'bet-123',
                '--api-url',
                `http://127.0.0.1:${port}/api`,
                '--allow-insecure',
            ],
            home,
        );
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(redeemBody.token, 'bet-123');

        const saved = readJson(path.join(home, 'probe.json'));
        assert.equal(saved.key, 'probe-xyz');
        assert.equal(saved.token, 'tnt-xyz');
    } finally {
        server.close();
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('enroll without a token fails fast', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beaconix-enroll-'));
    try {
        const result = await runCli(
            [
                'enroll',
                '--api-url',
                'https://api.example.com/api',
            ],
            home,
        );
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Missing --enroll-token/);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
