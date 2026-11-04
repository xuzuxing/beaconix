import type { RumPlugin } from '../types.js';

export function createRejectionPlugin(): RumPlugin {
    return {
        setup(context) {
            const onUnhandledRejection = (event: PromiseRejectionEvent) => {
                const reason = event.reason;
                const error =
                    reason instanceof Error
                        ? reason
                        : new Error(stringifyReason(reason));
                void context.captureError(error, {
                    type: 'unhandledrejection',
                    category: 'PROMISE',
                });
            };
            window.addEventListener('unhandledrejection', onUnhandledRejection);
            return () =>
                window.removeEventListener(
                    'unhandledrejection',
                    onUnhandledRejection,
                );
        },
    };
}

function stringifyReason(reason: unknown): string {
    if (typeof reason === 'string') return reason;
    try {
        return JSON.stringify(reason);
    } catch {
        return String(reason);
    }
}
