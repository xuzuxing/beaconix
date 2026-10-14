'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { loadConfig } = require('../config');
const { FleetApi } = require('../api');
const {
    provision,
    acquireStateLock,
    readState,
    saveState,
} = require('../provision');
const { supervise, agentEnvironment } = require('../supervisor');

const CLI = path.resolve(__dirname, '../index.js');
const SECRET = (id) => `sys_${id.toString(16).padStart(64, '0')}`;

async function backend(t, options = {}) {
    const probes = options.probes ?? [];
    const secrets = new Map(
        probes.map((probe, i) => [SECRET(i + 1), probe.id]),
    );
    const requests = [];
    let nextId = probes.length + 1;
    let accessToken = 'access-1';
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk;
        });
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : undefined;
            requests.push({
                route: req.url,
                method: req.method,
                body,
                headers: req.headers,
            });
            const send = (data, status = 200) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        data,
                        meta: { timestamp: new Date().toISOString() },
                    }),
                );
            };
            if (options.handle?.(req, res, body, send, requests)) return;
            if (req.url === '/api/auth/login') {
                send(
                    options.mfa
                        ? { twoFactorRequired: true }
                        : {
                              user: {
                                  globalRole: options.role ?? 'SUPER_ADMIN',
                              },
                              accessToken,
                              refreshToken: 'refresh-1',
                          },
                );
            } else if (req.url === '/api/auth/refresh') {
                accessToken = 'access-2';
                send({
                    user: { globalRole: 'SUPER_ADMIN' },
                    accessToken,
                    refreshToken: 'refresh-2',
                });
            } else if (
                req.url.startsWith('/api/admin/') &&
                req.headers.authorization !== `Bearer ${accessToken}`
            ) {
                send({}, 401);
            } else if (
                req.url === '/api/admin/system-probes' &&
                req.method === 'GET'
            ) {
                send(probes);
            } else if (
                req.url === '/api/admin/system-probes' &&
                req.method === 'POST'
            ) {
                const id = `probe-${nextId}`;
                const secret = SECRET(nextId++);
                const probe = {
                    id,
                    ...body,
                    scope: 'SYSTEM',
                    status: 'OFFLINE',
                };
                probes.push(probe);
                secrets.set(secret, id);
                send({ ...probe, secret }, 201);
            } else if (req.url === '/api/probes/heartbeat') {
                const id = secrets.get(req.headers['x-probe-secret']);
                const probe = probes.find((entry) => entry.id === id);
                if (!probe || !probe.enabled) {
                    send({}, 401);
                } else {
                    probe.status = 'ONLINE';
                    send({
                        probe: { id, status: 'ONLINE' },
                        monitors: options.monitorChecks
                            ? [
                                  {
                                      id: `monitor-${id}`,
                                      name: id,
                                      type: 'HTTP',
                                      target: `http://127.0.0.1:${server.address().port}/health`,
                                      expectedStatus: 200,
                                      timeout: 5000,
                                      interval: 60,
                                      configRevision: 1,
                                  },
                              ]
                            : [],
                        serverTime: new Date().toISOString(),
                    });
                }
            } else if (req.url === '/health') {
                send({ ok: true });
            } else if (req.url === '/api/probes/results') {
                send({
                    accepted: body.results.length,
                    applied: body.results.length,
                });
            } else if (req.url === '/api/probes/validation/pull') {
                send({ validation: null });
            } else if (req.url === '/api/admin/system-probes/rebalance') {
                send(Object.fromEntries(probes.map((probe) => [probe.id, []])));
            } else {
                send({}, 404);
            }
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    return {
        apiUrl: `http://127.0.0.1:${server.address().port}/api`,
        requests,
        probes,
        secrets,
    };
}

function configuration(t, apiUrl, overrides = {}) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beaconix-fleet-'));
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    return {
        ...loadConfig([], {
            BEACON_API_URL: apiUrl,
            BEACON_ADMIN_EMAIL: 'admin@example.test',
            BEACON_ADMIN_PASSWORD: 'test-only-password',
            PROBE_ALLOW_INSECURE: 'true',
            PROBE_FLEET_STATE_DIR: stateDir,
        }),
        startupDelayMs: 0,
        intervalSeconds: 5,
        readyTimeoutSeconds: 10,
        ...overrides,
    };
}

function client(config, controller = new AbortController(), wait) {
    return new FleetApi(config, controller.signal, () => {}, wait);
}

test('config validates limits and rejects unsafe transports without exposing arguments', () => {
    const env = {
        BEACON_ADMIN_EMAIL: ' ADMIN@EXAMPLE.TEST ',
        BEACON_ADMIN_PASSWORD: 'test-only',
        BEACON_API_URL: 'https://api.example.test/api/',
    };
    assert.equal(loadConfig([], env).count, 100);
    assert.equal(loadConfig([], env).email, 'admin@example.test');
    assert.equal(loadConfig(['--count', '3'], env).count, 3);
    assert.throws(() => loadConfig(['--count', '0'], env), /count must/);
    assert.throws(
        () => loadConfig(['--prefix', '../oops'], env),
        /prefix must/,
    );
    assert.throws(
        () => loadConfig(['password-accident'], env),
        /Unknown argument/,
    );
    assert.throws(
        () =>
            loadConfig([], {
                ...env,
                BEACON_API_URL: 'http://localhost:3000/api',
            }),
        /Local HTTP requires/,
    );
    assert.throws(
        () =>
            loadConfig([], {
                ...env,
                BEACON_API_URL: 'https://user:password@api.test',
            }),
        /without credentials/,
    );
    assert.throws(
        () => loadConfig([], { ...env, PROBE_INTERVAL_SECONDS: '4' }),
        /interval must/,
    );
    assert.throws(
        () => loadConfig([], { ...env, PROBE_INTERVAL_SECONDS: '3601' }),
        /interval must/,
    );
    assert.equal(loadConfig(['--help'], {}).help, true);
});

test('creates 100 distinct system probes, reuses all, then creates only the missing probe', async (t) => {
    const server = await backend(t);
    const config = configuration(t, server.apiUrl);
    const controller = new AbortController();
    const first = await provision(
        config,
        client(config),
        controller.signal,
        () => {},
    );
    assert.equal(first.length, 100);
    assert.equal(new Set(first.map((entry) => entry.id)).size, 100);
    assert.equal(new Set(first.map((entry) => entry.secret)).size, 100);
    assert.equal(server.probes.length, 100);
    assert.equal(first[0].name, 'docker-system-test-0001');
    assert.ok(
        server.probes.every(
            (entry) => entry.provider === 'CUSTOM' && entry.enabled,
        ),
    );
    const file = path.join(config.stateDir, 'credentials.json');
    const persisted = fs.readFileSync(file, 'utf8');
    assert.ok(!persisted.includes(config.password));
    assert.ok(!persisted.includes('access-1'));
    assert.ok(!persisted.includes('refresh-1'));
    if (process.platform !== 'win32')
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    const again = await provision(
        config,
        client(config),
        controller.signal,
        () => {},
    );
    assert.deepEqual(again, first);
    assert.equal(server.probes.length, 100);
    server.probes.splice(49, 1);
    const repaired = await provision(
        config,
        client(config),
        controller.signal,
        () => {},
    );
    assert.equal(server.probes.length, 100);
    assert.notEqual(repaired[49].id, first[49].id);
    assert.equal(repaired[0].id, first[0].id);
    assert.equal(
        server.requests.filter(
            (req) =>
                req.method === 'POST' &&
                req.route === '/api/admin/system-probes',
        ).length,
        101,
    );
});

test('unrelated probes are ignored and an existing managed name without a secret fails before creating', async (t) => {
    const server = await backend(t, {
        probes: [
            {
                id: 'production',
                name: 'production-tokyo',
                scope: 'SYSTEM',
                enabled: true,
            },
            {
                id: 'missing-secret',
                name: 'docker-system-test-0002',
                scope: 'SYSTEM',
                enabled: true,
            },
        ],
    });
    const config = configuration(t, server.apiUrl, { count: 3 });
    await assert.rejects(
        provision(
            config,
            client(config),
            new AbortController().signal,
            () => {},
        ),
        /exists without its saved secret/,
    );
    assert.equal(server.probes.length, 2);
    assert.ok(
        !server.requests.some((req) =>
            ['DELETE', 'PATCH'].includes(req.method),
        ),
    );
    assert.ok(
        !server.requests.some(
            (req) =>
                req.route === '/api/admin/system-probes' &&
                req.method === 'POST',
        ),
    );
});

test('a partial run saves each received secret and can resume without duplicating completed creates', async (t) => {
    let creates = 0;
    let fail = true;
    const server = await backend(t, {
        handle(req, res, body, send) {
            if (
                req.url === '/api/admin/system-probes' &&
                req.method === 'POST'
            ) {
                creates += 1;
                if (creates === 3 && fail) {
                    send({ password: 'must-not-be-logged' }, 503);
                    return true;
                }
            }
            return false;
        },
    });
    const config = configuration(t, server.apiUrl, { count: 5 });
    await assert.rejects(
        provision(
            config,
            client(config),
            new AbortController().signal,
            () => {},
        ),
        /HTTP 503/,
    );
    assert.equal(readState(config).probes.length, 2);
    assert.equal(creates, 3);
    fail = false;
    await provision(
        config,
        client(config),
        new AbortController().signal,
        () => {},
    );
    assert.equal(server.probes.length, 5);
    assert.equal(creates, 6);
});

test('fails safely for disabled probes, revoked secrets and mismatched manifest identity', async (t) => {
    const server = await backend(t);
    const config = configuration(t, server.apiUrl, { count: 1 });
    await provision(
        config,
        client(config),
        new AbortController().signal,
        () => {},
    );
    server.probes[0].enabled = false;
    await assert.rejects(
        provision(
            config,
            client(config),
            new AbortController().signal,
            () => {},
        ),
        /disabled/,
    );
    server.probes[0].enabled = true;
    server.secrets.clear();
    await assert.rejects(
        provision(
            config,
            client(config),
            new AbortController().signal,
            () => {},
        ),
        /HTTP 401/,
    );
    assert.equal(server.probes.length, 1);
    assert.throws(
        () =>
            readState({ ...config, apiUrl: 'https://other.example.test/api' }),
        /different API/,
    );
    const state = readState(config);
    state.probes.push(state.probes[0]);
    saveState(config, state);
    assert.throws(() => readState(config), /duplicate/);
});

test('enforces admin and explicitly rejects MFA login', async (t) => {
    for (const options of [{ role: 'USER' }, { mfa: true }]) {
        const server = await backend(t, options);
        const config = configuration(t, server.apiUrl, { count: 1 });
        await assert.rejects(
            provision(config, client(config), new AbortController().signal),
            options.mfa ? /MFA/ : /SUPER_ADMIN/,
        );
        assert.equal(server.probes.length, 0);
    }
});

test('retries 429 using Retry-After, refreshes expired JWT once, and never leaks API error bodies', async (t) => {
    let limited = false;
    let expired = false;
    const waits = [];
    const server = await backend(t, {
        handle(req, res, body, send) {
            if (req.url === '/api/admin/system-probes' && !limited) {
                limited = true;
                res.setHeader('Retry-After', '2');
                send({ secret: 'must-not-be-logged' }, 429);
                return true;
            }
            if (req.url === '/api/admin/system-probes' && !expired) {
                expired = true;
                send({ accessToken: 'must-not-be-logged' }, 401);
                return true;
            }
            return false;
        },
    });
    const config = configuration(t, server.apiUrl, { count: 1 });
    const api = client(config, undefined, async (delay) => {
        waits.push(delay);
    });
    await provision(config, api, new AbortController().signal, () => {});
    assert.deepEqual(waits, [2000]);
    assert.equal(
        server.requests.filter((req) => req.route === '/api/auth/refresh')
            .length,
        1,
    );
    assert.equal(server.probes.length, 1);
});

test('429 exhaustion is bounded and cancellation interrupts rate-limit waiting', async (t) => {
    const server = await backend(t, {
        handle(req, res, body, send) {
            res.setHeader('Retry-After', '60');
            send({ secret: 'private-response' }, 429);
            return true;
        },
    });
    const config = configuration(t, server.apiUrl, { rateRetries: 2 });
    const api = client(config, undefined, async () => {});
    await assert.rejects(
        api.login(),
        (error) =>
            /HTTP 429/.test(error.message) &&
            !error.message.includes('private-response'),
    );
    assert.equal(server.requests.length, 3);
    const controller = new AbortController();
    const pending = client(config, controller).login();
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, /abort/i);
});

test('state lock rejects simultaneous startup and can be reused after clean release', (t) => {
    const config = configuration(t, 'https://api.example.test/api');
    const release = acquireStateLock(config.stateDir);
    assert.throws(() => acquireStateLock(config.stateDir), /state is locked/);
    release();
    acquireStateLock(config.stateDir)();
});

test('agent child environment excludes administrator credentials and inherited probe configuration', () => {
    const config = {
        apiUrl: 'https://api.example.test/api',
        stateDir: '/data',
        allowInsecure: false,
        intervalSeconds: 60,
        timeoutMs: 5000,
        concurrency: 3,
    };
    const env = agentEnvironment(
        config,
        { id: 'id-1', secret: SECRET(1) },
        {
            PATH: 'test-path',
            BEACON_ADMIN_EMAIL: 'private@example.test',
            BEACON_ADMIN_PASSWORD: 'private-password',
            BEACON_ADMIN_PASSWORD_FILE: '/run/private',
            PROBE_CONFIG: '/wrong/config.json',
            PROBE_SECRET: 'wrong-secret',
            PROBE_FLEET_COUNT: '100',
        },
    );
    assert.equal(env.PATH, 'test-path');
    assert.equal(env.PROBE_TOKEN, SECRET(1));
    assert.equal(env.PROBE_KEY, 'id-1');
    assert.equal(env.BEACON_ADMIN_PASSWORD, undefined);
    assert.equal(env.BEACON_ADMIN_EMAIL, undefined);
    assert.equal(env.PROBE_CONFIG, undefined);
    assert.equal(env.PROBE_SECRET, undefined);
});

test('supervisor starts real independent agents, rebalances only after heartbeats, then stops them', async (t) => {
    const server = await backend(t);
    const config = configuration(t, server.apiUrl, { count: 3 });
    const controller = new AbortController();
    t.after(() => controller.abort());
    const api = client(config, controller);
    const credentials = await provision(
        config,
        api,
        controller.signal,
        () => {},
    );
    const logs = [];
    let done;
    const ready = new Promise((resolve) => {
        done = resolve;
    });
    const running = supervise(
        config,
        credentials,
        api,
        controller.signal,
        (line) => {
            logs.push(line);
            if (line.startsWith('Fleet ready:')) done();
        },
    );
    await Promise.race([
        ready,
        running.then(() => {
            throw new Error('Supervisor stopped before ready');
        }),
        sleep(12000, undefined, { ref: false }).then(() => {
            throw new Error('Timed out waiting for fleet');
        }),
    ]);
    const rebalances = server.requests.filter(
        (req) => req.route === '/api/admin/system-probes/rebalance',
    );
    assert.equal(rebalances.length, 1);
    const position = server.requests.findIndex(
        (req) => req.route === '/api/admin/system-probes/rebalance',
    );
    const heartbeatIds = new Set(
        server.requests
            .slice(0, position)
            .filter((req) => req.route === '/api/probes/heartbeat')
            .map((req) => server.secrets.get(req.headers['x-probe-secret'])),
    );
    assert.equal(heartbeatIds.size, 3);
    assert.ok(
        logs.every(
            (line) =>
                !line.includes(config.password) &&
                credentials.every((probe) => !line.includes(probe.secret)),
        ),
    );
    controller.abort();
    await running;
    assert.equal(
        logs.filter((line) => line.includes('Probe agent stopped')).length,
        process.platform === 'win32' ? 0 : 3,
    );
});

test('supervisor readiness failure terminates agents rather than declaring an empty fleet healthy', async (t) => {
    const server = await backend(t);
    const config = configuration(t, server.apiUrl, {
        count: 1,
        readyTimeoutSeconds: 1,
    });
    const controller = new AbortController();
    const api = client(config, controller);
    const credentials = await provision(
        config,
        api,
        controller.signal,
        () => {},
    );
    server.secrets.clear();
    await assert.rejects(
        supervise(config, credentials, api, controller.signal, () => {}),
        /0\/1 agents/,
    );
});

async function until(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline)
            throw new Error('Timed out waiting for test condition');
        await sleep(10);
    }
}

function fakeSpawner(children) {
    return (executable, args, options) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.killed = false;
        child.exitCode = null;
        child.signalCode = null;
        child.kill = (signal) => {
            if (child.killed) return false;
            child.killed = true;
            queueMicrotask(() => {
                child.signalCode = signal;
                child.emit('exit', null, signal);
                child.stdout.end();
                child.stderr.end();
                child.emit('close', 0, signal);
            });
            return true;
        };
        children.push(child);
        queueMicrotask(() =>
            child.stdout.write(
                `Heartbeat OK: probe=${options.env.PROBE_KEY} status=ONLINE monitors=0\n`,
            ),
        );
        return child;
    };
}

test('a child exit during rebalance cannot declare readiness; recovered generation rebalances again', async (t) => {
    const config = configuration(t, 'https://api.example.test/api', {
        count: 1,
    });
    const credentials = [
        { id: 'probe-1', name: 'docker-system-test-0001', secret: SECRET(1) },
    ];
    const controller = new AbortController();
    const children = [];
    const completions = [];
    const logs = [];
    const api = {
        request: () => new Promise((resolve) => completions.push(resolve)),
    };
    const running = supervise(
        config,
        credentials,
        api,
        controller.signal,
        (line) => logs.push(line),
        fakeSpawner(children),
    );
    running.catch(() => {});
    t.after(async () => {
        controller.abort();
        for (const complete of completions) complete({});
        await running.catch(() => {});
    });
    await until(() => completions.length === 1);
    children[0].kill('SIGKILL');
    completions[0]({ 'probe-1': [] });
    await sleep(40);
    assert.ok(!logs.some((line) => line.startsWith('Fleet ready:')));
    await until(() => completions.length === 2);
    assert.equal(children.length, 2);
    completions[1]({ 'probe-1': [] });
    await until(() => logs.some((line) => line.startsWith('Fleet ready:')));
    assert.equal(
        logs.filter((line) => line.startsWith('Fleet ready:')).length,
        1,
    );
    controller.abort();
    await running;
});

test('readiness timeout cancels an in-flight rebalance and ignores its late completion', async (t) => {
    const config = configuration(t, 'https://api.example.test/api', {
        count: 1,
        readyTimeoutSeconds: 1,
    });
    const controller = new AbortController();
    const children = [];
    const logs = [];
    let cancelled = false;
    const api = {
        request: (route, { signal }) =>
            new Promise((resolve) => {
                signal.addEventListener(
                    'abort',
                    () => {
                        cancelled = true;
                        resolve({});
                    },
                    { once: true },
                );
            }),
    };
    await assert.rejects(
        supervise(
            config,
            [
                {
                    id: 'probe-1',
                    name: 'docker-system-test-0001',
                    secret: SECRET(1),
                },
            ],
            api,
            controller.signal,
            (line) => logs.push(line),
            fakeSpawner(children),
        ),
        /readiness timed out/,
    );
    assert.equal(cancelled, true);
    assert.equal(children[0].killed, true);
    assert.ok(!logs.some((line) => line.startsWith('Fleet ready:')));
});

test('a stale assignment table is retried until it contains every selected probe', async (t) => {
    const config = configuration(t, 'https://api.example.test/api', {
        count: 1,
    });
    const controller = new AbortController();
    const logs = [];
    let requests = 0;
    const api = {
        request: async () => {
            requests += 1;
            return requests === 1 ? {} : { 'probe-1': [] };
        },
    };
    const running = supervise(
        config,
        [{ id: 'probe-1', name: 'docker-system-test-0001', secret: SECRET(1) }],
        api,
        controller.signal,
        (line) => logs.push(line),
        fakeSpawner([]),
    );
    running.catch(() => {});
    t.after(async () => {
        controller.abort();
        await running.catch(() => {});
    });
    await until(() => requests === 1);
    assert.ok(!logs.some((line) => line.startsWith('Fleet ready:')));
    await until(() => logs.some((line) => line.startsWith('Fleet ready:')));
    assert.equal(requests, 2);
    controller.abort();
    await running;
});

test('a natural process exit before stdio close invalidates pending readiness', async (t) => {
    const config = configuration(t, 'https://api.example.test/api', {
        count: 1,
    });
    const controller = new AbortController();
    const children = [];
    const logs = [];
    let complete;
    const api = {
        request: () =>
            new Promise((resolve) => {
                complete = resolve;
            }),
    };
    const running = supervise(
        config,
        [{ id: 'probe-1', name: 'docker-system-test-0001', secret: SECRET(1) }],
        api,
        controller.signal,
        (line) => logs.push(line),
        fakeSpawner(children),
    );
    running.catch(() => {});
    t.after(async () => {
        controller.abort();
        complete?.({ 'probe-1': [] });
        await running.catch(() => {});
    });
    await until(() => complete);
    children[0].exitCode = 1;
    children[0].emit('exit', 1, null);
    complete({ 'probe-1': [] });
    await sleep(40);
    assert.ok(!logs.some((line) => line.startsWith('Fleet ready:')));
    controller.abort();
    await running;
});

test(
    '100 real agent processes heartbeat, check HTTP targets and report with distinct credentials',
    {
        skip: process.env.BEACON_TEST_FLEET_FULL !== '1',
    },
    async (t) => {
        const server = await backend(t, { monitorChecks: true });
        const config = configuration(t, server.apiUrl, {
            count: 100,
            readyTimeoutSeconds: 60,
        });
        const controller = new AbortController();
        const api = client(config, controller);
        const credentials = await provision(
            config,
            api,
            controller.signal,
            () => {},
        );
        const logs = [];
        const running = supervise(
            config,
            credentials,
            api,
            controller.signal,
            (line) => logs.push(line),
        );
        running.catch(() => {});
        t.after(async () => {
            controller.abort();
            await running.catch(() => {});
        });
        try {
            await until(
                () => logs.some((line) => line.startsWith('Fleet ready: 100')),
                65000,
            );
            await until(
                () =>
                    new Set(
                        server.requests
                            .filter(
                                (req) => req.route === '/api/probes/results',
                            )
                            .map((req) => req.headers['x-probe-secret']),
                    ).size === 100,
                15000,
            );
            const reports = server.requests.filter(
                (req) => req.route === '/api/probes/results',
            );
            assert.ok(
                reports.every((req) =>
                    req.body.results.every(
                        (result) =>
                            result.success &&
                            result.statusCode === 200 &&
                            result.monitorId ===
                                `monitor-${server.secrets.get(req.headers['x-probe-secret'])}`,
                    ),
                ),
            );
            assert.equal(
                new Set(reports.map((req) => req.headers['x-probe-secret']))
                    .size,
                100,
            );
        } finally {
            controller.abort();
            await running;
        }
    },
);

test('CLI provision runs against a mock API and releases its state lock', async (t) => {
    const server = await backend(t);
    const config = configuration(t, server.apiUrl, { count: 2 });
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key]) => !/^(BEACON_|PROBE_)/i.test(key),
        ),
    );
    const child = spawn(process.execPath, [CLI, 'provision'], {
        env: {
            ...env,
            BEACON_API_URL: config.apiUrl,
            BEACON_ADMIN_EMAIL: config.email,
            BEACON_ADMIN_PASSWORD: config.password,
            PROBE_FLEET_COUNT: '2',
            PROBE_ALLOW_INSECURE: 'true',
            PROBE_FLEET_STATE_DIR: config.stateDir,
        },
        windowsHide: true,
    });
    t.after(() => child.kill('SIGKILL'));
    let output = '';
    child.stdout.on('data', (chunk) => {
        output += chunk;
    });
    child.stderr.on('data', (chunk) => {
        output += chunk;
    });
    const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
    });
    assert.equal(code, 0, output);
    assert.match(output, /Prepared 2 independent/);
    assert.ok(!output.includes(config.password));
    assert.equal(server.probes.length, 2);
    assert.equal(
        fs.existsSync(path.join(config.stateDir, 'fleet.lock')),
        false,
    );
});
