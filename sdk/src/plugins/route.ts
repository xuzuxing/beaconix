import type { RumPlugin } from '../types.js';

export function createRoutePlugin(): RumPlugin {
    return {
        setup(context) {
            let previous = context.currentPage();
            const record = (kind: string) => {
                const current = context.currentPage();
                if (current === previous) return;
                context.addBreadcrumb({
                    type: 'navigation',
                    category: kind,
                    level: 'INFO',
                    data: { from: previous, to: current },
                });
                previous = current;
            };
            const originalPushState = history.pushState;
            const originalReplaceState = history.replaceState;
            history.pushState = function (...args) {
                originalPushState.apply(this, args);
                record('pushState');
            };
            history.replaceState = function (...args) {
                originalReplaceState.apply(this, args);
                record('replaceState');
            };
            const onPopState = () => record('popstate');
            const onHashChange = () => record('hashchange');
            window.addEventListener('popstate', onPopState);
            window.addEventListener('hashchange', onHashChange);
            return () => {
                history.pushState = originalPushState;
                history.replaceState = originalReplaceState;
                window.removeEventListener('popstate', onPopState);
                window.removeEventListener('hashchange', onHashChange);
            };
        },
    };
}
