import { targetSelector } from '../sanitizer.js';
import type { RumPlugin } from '../types.js';

export function createClickPlugin(): RumPlugin {
    return {
        setup(context) {
            const onClick = (event: MouseEvent) => {
                context.addBreadcrumb({
                    type: 'click',
                    category: 'ui',
                    level: 'INFO',
                    data: {
                        target: targetSelector(event.target),
                        x: Math.round(event.clientX),
                        y: Math.round(event.clientY),
                    },
                });
            };
            window.addEventListener('click', onClick, true);
            return () => window.removeEventListener('click', onClick, true);
        },
    };
}
