import { registerAs } from '@nestjs/config';
import { optionalEnv, requireEnv } from './env';

export interface TwoFactorConfig {
    /** Displayed in the `otpauth://` URI (Authenticator app label prefix). */
    issuer: string;
    /** 32-byte key, base64-encoded, used to encrypt TOTP secrets at rest. */
    secretKey: string;
    /** Lifetime of a login challenge, in seconds. */
    challengeTtlSeconds: number;
    /** Lifetime of the setup handshake (pending secret), in seconds. */
    setupTtlSeconds: number;
    /** Failed code attempts allowed on a single challenge before it is burned. */
    maxAttempts: number;
    /** How many recovery codes are generated on enable / regeneration. */
    recoveryCodeCount: number;
}

function optionalInt(key: string, fallback: number): number {
    const parsed = parseInt(optionalEnv(key, String(fallback)), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Two-factor (TOTP) settings.
 *
 * `TWO_FACTOR_SECRET_KEY` is required: the app refuses to start without it
 * rather than silently falling back to storing TOTP secrets in plaintext.
 */
export const twoFactorConfig = registerAs('twoFactor', (): TwoFactorConfig => ({
    issuer: optionalEnv('TWO_FACTOR_ISSUER', 'Beaconix'),
    secretKey: requireEnv('TWO_FACTOR_SECRET_KEY'),
    challengeTtlSeconds: optionalInt('TWO_FACTOR_CHALLENGE_TTL_SECONDS', 300),
    setupTtlSeconds: optionalInt('TWO_FACTOR_SETUP_TTL_SECONDS', 600),
    maxAttempts: optionalInt('TWO_FACTOR_MAX_ATTEMPTS', 5),
    recoveryCodeCount: optionalInt('TWO_FACTOR_RECOVERY_CODE_COUNT', 10),
}));
