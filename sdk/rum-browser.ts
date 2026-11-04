export { RumBrowserClient } from './src/client.js';
export { BreadcrumbBuffer } from './src/breadcrumbs.js';
export { sanitizeRecord, sanitizeText, stripUrl } from './src/sanitizer.js';
export type {
    RumBreadcrumb,
    RumBrowserOptions,
    RumCaptureErrorOptions,
    RumCollectionOptions,
    RumErrorCategory,
    RumErrorLevel,
    RumErrorPayload,
    RumHttpContext,
    RumHttpInstrumentationOptions,
    RumResourceContext,
    RumSessionReplayOptions,
    RumVueAppLike,
    RumVueContext,
} from './src/types.js';

import { RumBrowserClient } from './src/client.js';
import type { RumBrowserOptions } from './src/types.js';

export function initRum(options: RumBrowserOptions): RumBrowserClient {
    const client = new RumBrowserClient(options);
    client.init();
    return client;
}
