import { SetMetadata } from '@nestjs/common';

export const SKIP_TRANSFORM_KEY = 'skipTransform';

/**
 * Marks a route whose response must be sent verbatim, bypassing the global
 * `TransformInterceptor` (`{ data, meta }` envelope). Used by endpoints whose
 * caller requires an exact, contract-defined body — e.g. WeChat Pay callbacks.
 */
export const SkipTransform = () => SetMetadata(SKIP_TRANSFORM_KEY, true);
