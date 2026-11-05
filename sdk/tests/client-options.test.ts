import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    DEFAULT_DEDUPE_WINDOW_MS,
    normalizePerformanceOptions,
} from '../src/client.js';

void test('performance collection requires explicit opt-in', () => {
    assert.deepEqual(normalizePerformanceOptions(undefined), {
        enabled: false,
    });
    assert.deepEqual(normalizePerformanceOptions(false), { enabled: false });
    assert.deepEqual(normalizePerformanceOptions(true), { enabled: true });
    assert.deepEqual(normalizePerformanceOptions({ sampleRate: 0.25 }), {
        sampleRate: 0.25,
        enabled: false,
    });
    assert.deepEqual(
        normalizePerformanceOptions({ enabled: true, sampleRate: 0.25 }),
        { enabled: true, sampleRate: 0.25 },
    );
});

void test('default error deduplication window is one second', () => {
    assert.equal(DEFAULT_DEDUPE_WINDOW_MS, 1_000);
});
