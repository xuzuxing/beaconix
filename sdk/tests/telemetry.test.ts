import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createClickPlugin } from '../src/plugins/click.js';
import { createHttpPlugin } from '../src/plugins/http.js';
import { createPageviewPlugin } from '../src/plugins/pageview.js';
import type { RumPerfSample, RumPluginContext } from '../src/types.js';

interface Harness {
    window: {
        location: { href: string };
        history: {
            pushState(data: unknown, unused: string, url?: string | URL | null): void;
            replaceState(data: unknown, unused: string, url?: string | URL | null): void;
        };
        addEventListener(type: string, handler: (event: unknown) => void): void;
        removeEventListener(type: string, handler: (event: unknown) => void): void;
        fetch?: typeof fetch;
    };
    events: Array<{ name: string; properties?: Record<string, unknown> }>;
    samples: RumPerfSample[];
    breadcrumbs: unknown[];
    errors: unknown[];
    context: RumPluginContext;
    dispatch(type: string, event: unknown): void;
}

let cleanup: (() => void) | undefined;

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
});

function installDom(href = 'https://app.test/home'): Harness {
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const location = { href };
    const history = {
        pushState(_data: unknown, _unused: string, url?: string | URL | null) {
            if (url) location.href = String(url);
        },
        replaceState(_data: unknown, _unused: string, url?: string | URL | null) {
            if (url) location.href = String(url);
        },
    };
    const window = {
        location,
        history,
        addEventListener(type: string, handler: (event: unknown) => void) {
            listeners.set(type, [...(listeners.get(type) ?? []), handler]);
        },
        removeEventListener(type: string, handler: (event: unknown) => void) {
            listeners.set(
                type,
                (listeners.get(type) ?? []).filter((item) => item !== handler),
            );
        },
        fetch: undefined as typeof fetch | undefined,
    };

    const events: Harness['events'] = [];
    const samples: RumPerfSample[] = [];
    const breadcrumbs: unknown[] = [];
    const errors: unknown[] = [];
    const context: RumPluginContext = {
        addBreadcrumb: (breadcrumb) => breadcrumbs.push(breadcrumb),
        captureError: async (error) => {
            errors.push(error);
        },
        captureEvent: async (eventName, properties) => {
            events.push({ name: eventName, ...(properties ? { properties } : {}) });
        },
        currentPage: () => location.href,
        shouldIgnoreUrl: () => false,
        reportPerformance: async (batch) => {
            samples.push(...batch);
        },
    };

    const previousWindow = (globalThis as { window?: unknown }).window;
    const previousHistory = (globalThis as { history?: unknown }).history;
    const globals = globalThis as Record<string, unknown>;
    globals.window = window;
    globals.history = history;

    cleanup = () => {
        globals.window = previousWindow;
        globals.history = previousHistory;
        listeners.clear();
    };

    return {
        window,
        events,
        samples,
        breadcrumbs,
        errors,
        context,
        dispatch(type, event) {
            for (const handler of listeners.get(type) ?? []) handler(event);
        },
    };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('pageview plugin reports once per URL and collapses identical navigations', async () => {
    const harness = installDom();
    const plugin = createPageviewPlugin();
    const stop = plugin.setup(harness.context);

    assert.deepEqual(
        harness.events.map((event) => event.name),
        ['$pageview'],
    );

    // Same URL (for example a replaceState that only rewrites the query) is not
    // a new page view.
    harness.window.history.replaceState(null, '', 'https://app.test/home');
    await flush();
    assert.equal(harness.events.length, 1);

    harness.window.history.pushState(null, '', 'https://app.test/pricing');
    await flush();
    assert.equal(harness.events.length, 2);
    assert.deepEqual(harness.events[1], {
        name: '$pageview',
        properties: { page: 'https://app.test/pricing' },
    });

    harness.dispatch('popstate', {});
    await flush();
    assert.equal(harness.events.length, 2);
    stop();
});

test('click plugin reports $click alongside breadcrumbs and caps the volume', () => {
    const harness = installDom();
    const plugin = createClickPlugin();
    const stop = plugin.setup(harness.context);

    harness.dispatch('click', { target: null, clientX: 12.4, clientY: 30.6 });
    assert.equal(harness.events.length, 1);
    assert.equal(harness.events[0]!.name, '$click');
    assert.deepEqual(harness.events[0]!.properties, { x: 12, y: 31 });
    assert.equal(harness.breadcrumbs.length, 1);

    for (let index = 0; index < 150; index += 1) {
        harness.dispatch('click', { target: null, clientX: 1, clientY: 1 });
    }
    assert.equal(harness.events.length, 100);
    // Breadcrumbs keep flowing after the cap so errors still carry context.
    assert.equal(harness.breadcrumbs.length, 151);
    stop();
});

test('http plugin reports one HTTP sample per request when timings are on', async () => {
    const harness = installDom();
    harness.window.fetch = stubFetch(200);
    const plugin = createHttpPlugin({ reportTimings: true });
    const stop = plugin.setup(harness.context);

    await harness.window.fetch!('/api/orders');
    assert.equal(harness.samples.length, 1);
    assert.match(harness.samples[0]!.metric, /^HTTP$/);
    assert.equal(harness.samples[0]!.success, true);
    assert.equal(harness.samples[0]!.dimension, 'https://app.test/api/orders');
    stop();
});

test('http plugin marks failures and keeps timings off by default', async () => {
    const harness = installDom();
    harness.window.fetch = stubFetch(503);
    const plugin = createHttpPlugin({ reportTimings: true });
    const stop = plugin.setup(harness.context);

    await harness.window.fetch!('/api/orders');
    assert.equal(harness.samples.length, 1);
    assert.equal(harness.samples[0]!.success, false);
    assert.equal(harness.errors.length, 1);
    stop();

    harness.samples.length = 0;
    harness.errors.length = 0;
    const quiet = installDom();
    quiet.window.fetch = stubFetch(200);
    const quietPlugin = createHttpPlugin();
    const stopQuiet = quietPlugin.setup(quiet.context);
    await quiet.window.fetch!('/api/orders');
    assert.equal(quiet.samples.length, 0);
    stopQuiet();
});

/** Minimal fetch that only exposes what the plugin reads. */
function stubFetch(status: number): typeof fetch {
    return (async () => ({
        status,
        headers: { get: () => null },
    })) as unknown as typeof fetch;
}
