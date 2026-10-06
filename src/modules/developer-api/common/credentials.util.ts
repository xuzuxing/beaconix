import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const API_KEY_PREFIX = 'bk_org_';
export const PAT_PREFIX = 'bk_pat_';

/** SHA-256 hex digest — tokens are high-entropy, so a fast hash is enough. */
export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

export function generateToken(
    prefix: typeof API_KEY_PREFIX | typeof PAT_PREFIX,
): string {
    return `${prefix}${randomBytes(32).toString('hex')}`;
}

/** Constant-time comparison for two equal-length hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Display-only prefix, e.g. bk_org_1a2b3c4d. */
export function toKeyPrefix(token: string, length = 15): string {
    return token.slice(0, length);
}
