import { sanitizeText } from '../sanitizer.js';
import type { RumPluginContext, RumVueAppLike } from '../types.js';

export function installVueErrorHandler(
    app: RumVueAppLike,
    context: RumPluginContext,
): () => void {
    const previous = app.config.errorHandler;
    const handler = (error: unknown, instance: unknown, info: string) => {
        const componentName = resolveComponentName(instance);
        void context.captureError(error, {
            type: error instanceof Error ? error.name : 'VueError',
            category: 'VUE',
            vue: {
                ...(componentName ? { componentName } : {}),
                info: sanitizeText(info, 500),
            },
        });
        previous?.(error, instance, info);
    };
    app.config.errorHandler = handler;
    return () => {
        if (app.config.errorHandler === handler) {
            app.config.errorHandler = previous;
        }
    };
}

function resolveComponentName(instance: unknown): string | undefined {
    if (!instance || typeof instance !== 'object') return undefined;
    const value = instance as {
        $options?: { name?: unknown; __name?: unknown };
        $?: { type?: { name?: unknown; __name?: unknown } };
    };
    const name =
        value.$options?.name ??
        value.$options?.__name ??
        value.$?.type?.name ??
        value.$?.type?.__name;
    return typeof name === 'string' ? sanitizeText(name, 200) : undefined;
}
