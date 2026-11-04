import type { RumPlugin } from '../types.js';

export function createErrorPlugin(): RumPlugin {
    return {
        setup(context) {
            const onError = (event: ErrorEvent) => {
                if (!event.error && isResourceTarget(event.target)) return;
                void context.captureError(
                    event.error ?? new Error(event.message || 'Script error'),
                    {
                        type: event.error?.name ?? 'Error',
                        category: 'JAVASCRIPT',
                    },
                );
            };
            window.addEventListener('error', onError);
            return () => window.removeEventListener('error', onError);
        },
    };
}

function isResourceTarget(target: EventTarget | null): boolean {
    return typeof Element !== 'undefined' && target instanceof Element;
}
