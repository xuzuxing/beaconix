import { serializeConsoleArguments } from '../sanitizer.js';
import type { RumErrorLevel, RumPlugin } from '../types.js';

const METHODS = ['debug', 'info', 'log', 'warn', 'error'] as const;

export function createConsolePlugin(): RumPlugin {
    return {
        setup(context) {
            const originals = new Map<
                (typeof METHODS)[number],
                (...data: unknown[]) => void
            >();
            for (const method of METHODS) {
                const original = console[method].bind(console);
                originals.set(method, original);
                console[method] = (...args: unknown[]) => {
                    context.addBreadcrumb({
                        type: 'console',
                        category: method,
                        level: levelFor(method),
                        data: { arguments: serializeConsoleArguments(args) },
                    });
                    original(...args);
                };
            }
            return () => {
                for (const [method, original] of originals) {
                    console[method] = original;
                }
            };
        },
    };
}

function levelFor(method: (typeof METHODS)[number]): RumErrorLevel {
    if (method === 'error') return 'ERROR';
    if (method === 'warn') return 'WARNING';
    return 'INFO';
}
