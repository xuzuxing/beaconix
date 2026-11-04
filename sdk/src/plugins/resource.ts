import { stripUrl } from '../sanitizer.js';
import type { RumPlugin } from '../types.js';

export function createResourcePlugin(): RumPlugin {
    return {
        setup(context) {
            const onResourceError = (event: Event) => {
                const target = event.target;
                if (!(target instanceof Element)) return;
                const url = resourceUrl(target);
                if (!url || context.shouldIgnoreUrl(url)) return;
                const tagName = target.tagName.toLowerCase();
                void context.captureError(
                    new Error(`Failed to load ${tagName} resource`),
                    {
                        type: `${tagName}.load`,
                        category: 'RESOURCE',
                        resource: { tagName, url: stripUrl(url) },
                    },
                );
            };
            window.addEventListener('error', onResourceError, true);
            return () =>
                window.removeEventListener('error', onResourceError, true);
        },
    };
}

function resourceUrl(element: Element): string | null {
    if (element instanceof HTMLScriptElement) return element.src;
    if (element instanceof HTMLLinkElement) return element.href;
    if (element instanceof HTMLImageElement)
        return element.currentSrc || element.src;
    if (element instanceof HTMLSourceElement) return element.src;
    if (element instanceof HTMLAudioElement)
        return element.currentSrc || element.src;
    if (element instanceof HTMLVideoElement)
        return element.currentSrc || element.src;
    return element.getAttribute('src') || element.getAttribute('href');
}
