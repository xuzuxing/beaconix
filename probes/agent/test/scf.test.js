'use strict';

/**
 * SCF handler tests.
 *
 * A cloud function gets no local state, so every invocation must be a complete
 * cycle: validation pull → heartbeat → checks → report. Credentials come from
 * the environment (there is no credential file).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

function startBackend(records) {
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
            const port = server.address().port;
            records.push({
                method: req.method,
                url: req.url,
                body: raw ? JSON.parse(raw) : null,
            });

            if (req.url === '/api/probes/validation/pull') {
                res.setHeader('content-type', 'application/json');
                return res.end(JSON.stringify({ data: { validation: null } }));
            }
            if (req.url === '/api/probes/heartbeat') {
                res.setHeader('content-type', 'application/json');
                return res.end(
                    JSON.stringify({
                        data: {
                            probe: { id: 'probe-test', status: 'ONLINE' },
                            monitors: [
                                {
                                    id: 'm1',
                                    name: 'Health',
                                    type: 'HTTP',
                                    target: `http://127.0.0.1:${port}/health`,
                                    interval: 10,
                                    timeout: 1000,
                                    expectedStatus: 200,
                                    configRevision: 7,
                                },
                            ],
                            serverTime: 'fixed',
                        },
                    }),
                );
            }
            if (req.url === '/api/probes/results') {
                res.setHeader('content-type', 'application/json');
                return res.end(JSON.stringify({ data: { accepted: 1 } }));
            }
            if (req.url === '/health') {
                res.setHeader('content-type', 'text/plain');
                return res.end('ok');
            }

            res.statusCode = 404;
            res.end('{}');
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function setEnv(apiUrl) {
    process.env.BEACON_API_URL = apiUrl;
    process.env.PROBE_KEY = 'probe-test';
    process.env.PROBE_TOKEN = 'tnt-test';
    process.env.PROBE_INTERVAL_SECONDS = '300';
    process.env.PROBE_ALLOW_INSECURE = 'true';
    process.env.PROBE_CONCURRENCY = '5';
    delete process.env.PROBE_CONFIG;
}

test('one invocation runs exactly one full cycle using env credentials', async () => {
    const records = [];
    const server = await startBackend(records);
    const port = server.address().port;

    setEnv(`http://127.0.0.1:${port}/api`);

    try {
        const scf = require('../functions/scf.js');
        const result = await scf.main_handler({}, {});

        assert.equal(result.code, 0, JSON.stringify(result));
        assert.equal(result.mode, 'run');

        const apiUrls = records
            .map((r) => r.url)
            .filter((url) => url.startsWith('/api/'));
        assert.deepEqual(apiUrls, [
            '/api/probes/validation/pull',
            '/api/probes/heartbeat',
            '/api/probes/results',
        ]);

        // The heartbeat must advertise the cadence the trigger actually runs at.
        const heartbeat = records.find((r) => r.url === '/api/probes/heartbeat');
        assert.deepEqual(heartbeat.body, { intervalSeconds: 300 });

        const results = records.find((r) => r.url === '/api/probes/results');
        assert.equal(
            results.body.results[0].target,
            `http://127.0.0.1:${port}/health`,
        );
        assert.equal(results.body.results[0].success, true);
        assert.equal(results.body.results[0].monitorId, 'm1');
        assert.equal(results.body.results[0].configRevision, 7);
        assert.equal(results.body.results[0].statusCode, 200);
        assert.match(results.body.results[0].reportId, /^[0-9a-f-]{36}$/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('a failed run is returned as code 1 instead of throwing', async () => {
    // Nothing listens on port 9: heartbeat fails, so the cycle fails.
    setEnv('http://127.0.0.1:9/api');

    const scf = require('../functions/scf.js');
    const result = await scf.main_handler({}, {});

    assert.equal(result.code, 1);
    assert.equal(result.mode, 'run');
    assert.ok(typeof result.error === 'string' && result.error.length > 0);
});

test('index.main is the SCF root entry point', () => {
    const entry = require('../index.js');
    assert.equal(typeof entry.main, 'function');
    assert.equal(typeof require('../functions/scf.js').main_handler, 'function');
});
