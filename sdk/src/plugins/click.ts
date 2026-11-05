import { sanitizeText, targetSelector } from '../sanitizer.js';
import type { RumPlugin } from '../types.js';

/**
 * Clicks are capped per session: the console only needs a volume signal for the
 * overview chart, and an unbounded listener would flood ingest on data-heavy
 * pages. Breadcrumbs are still collected after the cap is reached.
 */
const MAX_CLICK_EVENTS = 100;

export function createClickPlugin(): RumPlugin {
    return {
        setup(context) {
            let reported = 0;
            const onClick = (event: MouseEvent) => {
                const target = targetSelector(event.target);
                context.addBreadcrumb({
                    type: 'click',
                    category: 'ui',
                    level: 'INFO',
                    data: {
                        target,
                        x: Math.round(event.clientX),
                        y: Math.round(event.clientY),
                    },
                });
                if (reported >= MAX_CLICK_EVENTS) return;
                reported += 1;
                void context.captureEvent('$click', {
                    ...(target ? { target: sanitizeText(target, 300) } : {}),
                    x: Math.round(event.clientX),
                    y: Math.round(event.clientY),
                });
            };
            window.addEventListener('click', onClick, true);
            return () => window.removeEventListener('click', onClick, true);
        },
    };
}
