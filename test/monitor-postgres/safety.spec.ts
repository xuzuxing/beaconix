import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateTestUrl } from './harness';

for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    void test(`accepts an explicit local disposable URL on ${host}`, () => {
        const url = `postgresql://test:secret@${host}:5432/beacon_monitor_test_ci`;
        assert.equal(validateTestUrl(url), url);
    });
}

for (const value of [
    undefined,
    '',
    'not a URL',
    'https://localhost/beacon_monitor_test',
    'postgresql://test:secret@db.example.com/beacon_monitor_test',
    'postgresql://test:secret@127.0.0.2/beacon_monitor_test',
    'postgresql://test:secret@localhost/beaconix',
    'postgresql://test:secret@localhost/postgres',
    'postgresql://test:secret@localhost/beacon_monitor_test_backup/extra',
    'postgresql://test:secret@localhost/beacon_monitor_test?schema=public',
    'postgresql://test:secret@localhost/beacon_monitor_test?host=remote',
    'postgresql://test:secret@localhost/beacon_monitor_test#fragment',
]) {
    void test(`refuses unsafe or missing URL case ${String(value?.length)}`, () => {
        assert.throws(
            () => validateTestUrl(value),
            (error: Error) =>
                error.message.includes('No DATABASE_URL fallback') &&
                !error.message.includes('secret'),
        );
    });
}
