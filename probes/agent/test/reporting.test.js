'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createSchedule } = require('../src/schedule');

async function fixture(t) {
    const batches = [];
    let fail = false;
    const server = http.createServer((req, res) => {
        if (req.url === '/health') {
            res.writeHead(503);
            res.end('unavailable');
            return;
        }
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            batches.push(JSON.parse(raw).results);
            res.writeHead(fail ? 503 : 200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: { accepted: 1 } }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const root = `http://127.0.0.1:${server.address().port}`;
    const config = { apiUrl: `${root}/api`, token: 'test-only', timeoutMs: 1000,
        maxResultsPerReport: 100 };
    const monitor = { id: 'm1', target: `${root}/health`, type: 'HTTP',
        expectedStatus: 200, configRevision: 4, interval: 60 };
    return { batches, config, monitor, setFailure: (value) => { fail = value; } };
}

test('duplicate targets retain separate monitor identity and original HTTP status', async (t) => {
    const { batches, config, monitor } = await fixture(t);
    const schedule = createSchedule();
    schedule.sync([monitor, { ...monitor, id: 'm2' }]);
    assert.equal((await schedule.runDue(config)).executed, 2);
    assert.equal(await schedule.flush(config), 2);
    assert.deepEqual(batches[0].map((r) => r.monitorId).sort(), ['m1', 'm2']);
    assert.equal(new Set(batches[0].map((r) => r.reportId)).size, 2);
    for (const row of batches[0]) {
        assert.equal(row.configRevision, 4);
        assert.equal(row.statusCode, 503);
        assert.equal(row.success, false);
    }
});

test('a failed report retries the exact same IDs, timestamps and payloads', async (t) => {
    const { batches, config, monitor, setFailure } = await fixture(t);
    const schedule = createSchedule();
    schedule.sync([monitor]);
    await schedule.runDue(config);
    setFailure(true);
    await assert.rejects(schedule.flush(config), /503/);
    assert.equal(schedule.buffered(), 1);
    setFailure(false);
    assert.equal(await schedule.flush(config), 1);
    assert.deepEqual(batches[1], batches[0]);
    assert.equal(schedule.buffered(), 0);
});

test('reconfigured or unassigned observations are not reinterpreted or retried', async (t) => {
    const { batches, config, monitor } = await fixture(t);
    const schedule = createSchedule();
    schedule.sync([monitor]);
    await schedule.runDue(config);
    schedule.sync([{ ...monitor, configRevision: 5 }]);
    assert.equal(await schedule.flush(config), 0);
    await schedule.runDue(config);
    schedule.sync([]);
    assert.equal(await schedule.flush(config), 0);
    assert.equal(batches.length, 0);
});
