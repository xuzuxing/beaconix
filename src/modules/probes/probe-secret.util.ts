import { createHash } from 'node:crypto';

/**
 * Probe credential helpers.
 *
 * A probe secret is stored only as its sha256 hash — the raw value is never
 * persisted. The same hash is what the validation challenge is keyed by, so the
 * probe derives its key from `sha256(secret)` and the backend from the stored
 * hash, without either side needing the plaintext at rest.
 */

/** sha256 hex of a raw probe secret — the only form ever stored. */
export function hashSecret(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Display-only prefix (e.g. `tnt_1a2b3c4d`) so a credential is identifiable. */
export function secretPrefixOf(secret: string): string {
    return secret.slice(0, 12);
}
