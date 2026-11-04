import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpPlugin } from '../src/plugins/http.js';
import type {
    RumCaptureErrorOptions,
    RumPluginContext,
} from '../src/types.js';

test('HTTP plugin suppresses a recoverable 401 through shouldReportError', async () => {
    const captured: RumCaptureErrorOptions[] = [];
    const breadcrumbs: Array<{ category?: string }> = [];
    const restoreWindow = installFetchWindow(
        async () => new Response(null, { status: 401 }),
    );
    const plugin = createHttpPlugin({
        shouldReportError: (context) => context.status !== 401,
    });
    const cleanup = plugin.setup(
        context(captured, breadcrumbs) as RumPluginContext,
    );
    try {
        await window.fetch('https://api.example.test/profile', {
            method: 'GET',
        });
        assert.equal(captured.length, 0);
        assert.deepEqual(breadcrumbs, [{ category: 'ignored-failure' }]);
    } finally {
        cleanup();
        restoreWindow();
    }
});

test('HTTP plugin reports a final server failure without request bodies', async () => {
    const captured: RumCaptureErrorOptions[] = [];
    const breadcrumbs: Array<{ category?: string }> = [];
    const restoreWindow = installFetchWindow(
        async () => new Response(null, { status: 503 }),
    );
    const cleanup = createHttpPlugin().setup(
        context(captured, breadcrumbs) as RumPluginContext,
    );
    try {
        await window.fetch('https://api.example.test/profile?token=secret', {
            method: 'POST',
            body: JSON.stringify({ password: 'not-collected' }),
        });
        assert.equal(captured.length, 1);
        assert.deepEqual(captured[0].http, {
            method: 'POST',
            url: 'https://api.example.test/profile',
            status: 503,
            durationMs: captured[0].http?.durationMs,
        });
        assert.equal('body' in (captured[0].http ?? {}), false);
    } finally {
        cleanup();
        restoreWindow();
    }
});

function context(
    captured: RumCaptureErrorOptions[],
    breadcrumbs: Array<{ category?: string }>,
) {
    return {
        addBreadcrumb: (breadcrumb: { category?: string }) =>
            breadcrumbs.push({ category: breadcrumb.category }),
        captureError: (_error: unknown, options?: RumCaptureErrorOptions) => {
            captured.push(options ?? {});
            return Promise.resolve();
        },
        currentPage: () => 'https://app.example.test/',
        shouldIgnoreUrl: () => false,
    };
}

function installFetchWindow(fetch: typeof window.fetch): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        writable: true,
        value: { fetch },
    });
    return () => {
        if (descriptor) {
            Object.defineProperty(globalThis, 'window', descriptor);
        } else {
            delete (globalThis as { window?: unknown }).window;
        }
    };
}
