import { createHash } from 'node:crypto';

export const RUM_FINGERPRINT_VERSION = 1;

export function createRumErrorFingerprint(
    appId: string,
    type: string,
    message: string,
): string {
    return createHash('sha256')
        .update(
            `${RUM_FINGERPRINT_VERSION}\u0000${appId}\u0000${type}\u0000${message}`,
        )
        .digest('hex');
}
