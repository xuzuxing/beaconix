import type { RumPlugin } from '../types.js';

/**
 * Reports `$pageview` once on load and once per SPA navigation.
 *
 * The backend aggregates these events into PV/UV and uses PV as the denominator
 * of the JS error rate, so the plugin must not double count: a navigation that
 * lands on the same URL (for example a `replaceState` that only rewrites the
 * query string) is collapsed into the previous report.
 */
export function createPageviewPlugin(): RumPlugin {
    return {
        setup(context) {
            let previous = '';
            const report = () => {
                const page = context.currentPage();
                if (!page || page === previous) return;
                previous = page;
                void context.captureEvent('$pageview', { page });
            };
            // Report after the host application finishes updating the URL.
            const schedule = () => {
                void Promise.resolve().then(report);
            };

            const originalPushState = history.pushState;
            const originalReplaceState = history.replaceState;
            history.pushState = function (...args) {
                originalPushState.apply(this, args);
                schedule();
            };
            history.replaceState = function (...args) {
                originalReplaceState.apply(this, args);
                schedule();
            };
            window.addEventListener('popstate', schedule);
            window.addEventListener('hashchange', schedule);
            report();

            return () => {
                history.pushState = originalPushState;
                history.replaceState = originalReplaceState;
                window.removeEventListener('popstate', schedule);
                window.removeEventListener('hashchange', schedule);
            };
        },
    };
}
