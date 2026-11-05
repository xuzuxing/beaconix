import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createWebVitalsPlugin } from '../src/plugins/web-vitals.js';
import type { RumPerfSample, RumPluginContext } from '../src/types.js';

class FakePerformanceObserver {
    static instances: FakePerformanceObserver[] = [];
    private type = '';
    private callback: (list: { getEntries: () => unknown[] }) => void;
    disconnected = false;

    constructor(callback: (list: { getEntries: () => unknown[] }) => void) {
        this.callback = callback;
        FakePerformanceObserver.instances.push(this);
    }

    observe(options: { type: string }) {
        this.type = options.type;
    }

    disconnect() {
        this.disconnected = true;
    }

    emit(entries: unknown[]) {
        this.callback({ getEntries: () => entries });
    }

    static for(type: string) {
        return FakePerformanceObserver.instances.find(
            (instance) => instance.type === type,
        );
    }
}

function context(samples: RumPerfSample[]): RumPluginContext {
    return {
        addBreadcrumb: () => {},
        captureError: () => Promise.resolve(),
        currentPage: () => '/dashboard',
        shouldIgnoreUrl: () => false,
        reportPerformance: (batch) => {
            samples.push(...batch);
            return Promise.resolve();
        },
    };
}

function installGlobals() {
    FakePerformanceObserver.instances = [];
    const listeners = new Map<string, () => void>();
    const globals = globalThis as Record<string, unknown>;
    globals.PerformanceObserver = FakePerformanceObserver;
    globals.window = {
        location: { href: 'https://app.example.com/dashboard' },
        addEventListener: (type: string, handler: () => void) =>
            listeners.set(type, handler),
        removeEventListener: () => {},
    };
    globals.document = {
        visibilityState: 'visible',
        addEventListener: (type: string, handler: () => void) =>
            listeners.set(type, handler),
        removeEventListener: () => {},
    };
    Object.defineProperty(globalThis, 'performance', {
        configurable: true,
        value: {
            getEntriesByType: () => [{ responseStart: 120, loadEventEnd: 900 }],
        },
    });
    return listeners;
}

function restoreGlobals() {
    const globals = globalThis as Record<string, unknown>;
    delete globals.PerformanceObserver;
    delete globals.window;
    delete globals.document;
    delete (globals as { performance?: unknown }).performance;
}

describe('web vitals plugin', () => {
    beforeEach(() => {
        installGlobals();
    });

    afterEach(() => {
        restoreGlobals();
    });

    test('reports vitals, navigation and slow resources on teardown', async () => {
        const samples: RumPerfSample[] = [];
        const plugin = createWebVitalsPlugin({ flushIntervalMs: 60_000 });
        const cleanup = plugin.setup(context(samples));

        FakePerformanceObserver.for('paint')?.emit([
            { name: 'first-contentful-paint', startTime: 1200 },
        ]);
        FakePerformanceObserver.for('largest-contentful-paint')?.emit([
            { startTime: 2100 },
        ]);
        FakePerformanceObserver.for('layout-shift')?.emit([
            { value: 0.12, hadRecentInput: false },
            { value: 0.5, hadRecentInput: true },
        ]);
        FakePerformanceObserver.for('event')?.emit([{ duration: 180 }]);
        FakePerformanceObserver.for('resource')?.emit([
            {
                name: 'https://cdn.example.com/app.js?v=1',
                duration: 1500,
                initiatorType: 'script',
                transferSize: 2048,
            },
            {
                name: 'https://api.example.com/users',
                duration: 1300,
                initiatorType: 'fetch',
                transferSize: 512,
            },
            {
                name: 'https://cdn.example.com/small.css',
                duration: 40,
                initiatorType: 'link',
                transferSize: 200,
            },
        ]);

        cleanup();
        await Promise.resolve();

        const metrics = samples.map((sample) => sample.metric);
        assert.deepEqual(metrics.sort(), [
            'CLS',
            'FCP',
            'HTTP',
            'INP',
            'LCP',
            'PAGE_LOAD',
            'RESOURCE',
            'TTFB',
        ]);
        assert.equal(
            samples.find((sample) => sample.metric === 'RESOURCE')?.dimension,
            'https://cdn.example.com/app.js',
        );
        assert.equal(
            samples.find((sample) => sample.metric === 'HTTP')?.success,
            true,
        );
        assert.ok(samples.every((sample) => sample.page === '/dashboard'));
    });

    test('flushes when the page becomes hidden', async () => {
        const samples: RumPerfSample[] = [];
        const listeners = installGlobals();
        const plugin = createWebVitalsPlugin({ flushIntervalMs: 60_000 });
        const cleanup = plugin.setup(context(samples));

        FakePerformanceObserver.for('largest-contentful-paint')?.emit([
            { startTime: 2312 },
        ]);
        (globalThis.document as { visibilityState: string }).visibilityState =
            'hidden';
        listeners.get('visibilitychange')?.();
        await Promise.resolve();
        cleanup();

        assert.deepEqual(
            samples.map((sample) => [sample.metric, sample.value]),
            [
                ['LCP', 2312],
                ['TTFB', 120],
                ['PAGE_LOAD', 900],
            ],
        );
    });

    test('leaves the host application alone when observers are unsupported', () => {
        const globals = globalThis as Record<string, unknown>;
        delete globals.PerformanceObserver;

        const plugin = createWebVitalsPlugin();
        const cleanup = plugin.setup(context([]));

        assert.equal(typeof cleanup, 'function');
        cleanup();
    });
});
