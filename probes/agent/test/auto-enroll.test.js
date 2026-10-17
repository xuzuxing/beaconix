'use strict';

/**
 * `run` on a fresh host: no credential → device authorization → credential is
 * stored → the probe keeps running and reports a heartbeat.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'probes', 'agent', 'bin', 'beaconix-probe.js');

function startMock() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => {
                const port = server.address().port;
                const send = (data) => {
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({ data }));
                };

                if (req.url === '/api/probes/enroll/device') {
                    send({
                        deviceCode: 'device-code',
                        userCode: 'ABCD-1234',
                        verificationUri: `http://127.0.0.1:${port}/activate`,
                        verificationUriComplete: `http://127.0.0.1:${port}/activate?code=ABCD-1234`,
                        expiresIn: 60,
                        interval: 1,
                    });
                } else if (req.url === '/api/probes/enroll/token') {
                    send({
                        status: 'approved',
                        credential: {
                            probeId: 'probe-auto',
                            secret: 'tnt-auto',
                            apiUrl: `http://127.0.0.1:${port}/api`,
                        },
                    });
                } else if (req.url === '/api/probes/heartbeat') {
                    send({
                        probe: { id: 'probe-auto', status: 'ONLINE' },
                        monitors: [],
                    });
                } else {
                    res.statusCode = 404;
                    res.end('{}');
                }
            });
        });

        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function waitFor(read, pattern, label) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + 20000;
        const tick = () => {
            if (pattern.test(read())) return resolve();
            if (Date.now() > deadline) {
                return reject(
                    new Error(`timed out waiting for ${label}\n${read()}`),
                );
            }
            setTimeout(tick, 50);
        };
        tick();
    });
}

test('run enrolls through the device flow when no credential exists', async () => {
    const home = fs.mkdtempSync(
        path.join(os.tmpdir(), 'beaconix-auto-enroll-'),
    );
    const server = await startMock();
    const port = server.address().port;

    const env = {
        ...process.env,
        BEACON_HOME: home,
        BEACON_LOG_DIR: path.join(home, 'logs'),
        BEACON_RUN_DIR: path.join(home, 'run'),
        BEACON_API_URL: `http://127.0.0.1:${port}/api`,
        PROBE_ALLOW_INSECURE: 'true',
        PROBE_INTERVAL_SECONDS: '1',
    };
    for (const key of [
        'PROBE_CONFIG',
        'PROBE_KEY',
        'PROBE_TOKEN',
        'PROBE_SECRET',
        'PROBE_ENROLL_TOKEN',
    ]) {
        delete env[key];
    }

    const child = spawn(process.execPath, [CLI, 'run'], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    try {
        await waitFor(
            () => stdout + stderr,
            /Open:\s+http:\/\/127\.0\.0\.1:\d+\/activate/,
            'the approval URL',
        );
        await waitFor(() => stdout + stderr, /Heartbeat OK/, 'a heartbeat');

        const stored = JSON.parse(
            fs.readFileSync(path.join(home, 'probe.json'), 'utf8'),
        );
        assert.equal(stored.key, 'probe-auto');
        assert.equal(stored.token, 'tnt-auto');

        child.kill('SIGTERM');
        const code = await new Promise((resolve) =>
            child.on('close', resolve),
        );
        // Windows force-terminates on SIGTERM (no signal handler runs), so the
        // close code is null there; POSIX hosts exit gracefully with 0.
        assert.ok(
            code === 0 || code === null,
            `unexpected exit code: ${code}\n${stdout}\n${stderr}`,
        );
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
        }
        server.close();
        fs.rmSync(home, { recursive: true, force: true });
    }
});
