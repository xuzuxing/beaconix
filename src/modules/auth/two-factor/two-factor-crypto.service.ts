import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import {
    generateSecret,
    generateURI,
    verify,
    type HashAlgorithm,
} from 'otplib';
import { TwoFactorConfig } from '../../../config';

/** Unambiguous alphabet (no 0/O/1/I/L) for human-typed recovery codes. */
const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RECOVERY_CODE_GROUP_SIZE = 4;
const RECOVERY_CODE_GROUP_COUNT = 3;
const RECOVERY_CODE_SALT_ROUNDS = 12;

const TOTP_ALGORITHM: HashAlgorithm = 'sha1';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
/** Accept the previous and the next step (±1 period, i.e. ±30s). */
const TOTP_EPOCH_TOLERANCE = TOTP_PERIOD_SECONDS;
const TOTP_TOKEN_PATTERN = /^\d{6}$/;

const AES_ALGORITHM = 'aes-256-gcm';
const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;
const CIPHER_VERSION = 'v1';

const OPAQUE_TOKEN_BYTES = 32;

/**
 * Pure(ish) cryptographic primitives for 2FA: TOTP generation/verification,
 * at-rest secret encryption, one-shot recovery codes and opaque token hashing.
 *
 * Keeps every crypto detail out of `TwoFactorService`, which only orchestrates
 * persistence and flow.
 */
@Injectable()
export class TwoFactorCryptoService {
    private readonly logger = new Logger(TwoFactorCryptoService.name);
    private readonly key: Buffer;
    private readonly issuer: string;
    private readonly recoveryCodeCount: number;

    constructor(private readonly configService: ConfigService) {
        const config = this.configService.get<TwoFactorConfig>('twoFactor')!;

        this.key = Buffer.from(config.secretKey, 'base64');
        if (this.key.length !== AES_KEY_BYTES) {
            // Fail fast: a wrong-length key would silently weaken encryption.
            throw new Error(
                'TWO_FACTOR_SECRET_KEY must be a base64-encoded 32-byte key',
            );
        }

        this.issuer = config.issuer;
        this.recoveryCodeCount = config.recoveryCodeCount;
    }

    // ─── TOTP ──────────────────────────────────────────────────────────

    /** Generates a fresh Base32 TOTP secret (160-bit, Authenticator-compatible). */
    generateTotpSecret(): string {
        return generateSecret();
    }

    /** Builds the `otpauth://totp/...` URI that backs the enrollment QR code. */
    buildOtpauthUrl(secret: string, label: string): string {
        return generateURI({
            strategy: 'totp',
            issuer: this.issuer,
            label,
            secret,
            algorithm: TOTP_ALGORITHM,
            digits: TOTP_DIGITS,
            period: TOTP_PERIOD_SECONDS,
        });
    }

    /** True when `code` is shaped like a TOTP token (6 digits), not a recovery code. */
    isTotpFormat(code: string): boolean {
        return TOTP_TOKEN_PATTERN.test(code);
    }

    /** Verifies a TOTP token against the secret, tolerating ±1 time step. */
    async verifyTotp(secret: string, token: string): Promise<boolean> {
        if (!this.isTotpFormat(token)) return false;

        try {
            const result = await verify({
                secret,
                token,
                algorithm: TOTP_ALGORITHM,
                digits: TOTP_DIGITS,
                period: TOTP_PERIOD_SECONDS,
                epochTolerance: TOTP_EPOCH_TOLERANCE,
            });
            return result.valid;
        } catch (error) {
            this.logger.warn(`TOTP verification failed: ${String(error)}`);
            return false;
        }
    }

    // ─── Secret encryption (AES-256-GCM) ───────────────────────────────

    /** Encrypts a TOTP secret as `v1:<iv>:<tag>:<ciphertext>` (all base64). */
    encryptSecret(plain: string): string {
        const iv = crypto.randomBytes(AES_IV_BYTES);
        const cipher = crypto.createCipheriv(AES_ALGORITHM, this.key, iv);
        const ciphertext = Buffer.concat([
            cipher.update(plain, 'utf8'),
            cipher.final(),
        ]);
        const tag = cipher.getAuthTag();

        return [
            CIPHER_VERSION,
            iv.toString('base64'),
            tag.toString('base64'),
            ciphertext.toString('base64'),
        ].join(':');
    }

    /** Reverses {@link encryptSecret}; throws on tampering or an unknown version. */
    decryptSecret(payload: string): string {
        const [version, ivB64, tagB64, ciphertextB64] = payload.split(':');
        if (version !== CIPHER_VERSION || !ivB64 || !tagB64 || !ciphertextB64) {
            throw new Error('Unsupported two-factor secret payload');
        }

        const decipher = crypto.createDecipheriv(
            AES_ALGORITHM,
            this.key,
            Buffer.from(ivB64, 'base64'),
        );
        decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

        return Buffer.concat([
            decipher.update(Buffer.from(ciphertextB64, 'base64')),
            decipher.final(),
        ]).toString('utf8');
    }

    // ─── Recovery codes ────────────────────────────────────────────────

    /** Generates one plaintext recovery code, formatted `xxxx-xxxx-xxxx`. */
    generateRecoveryCode(): string {
        const groups: string[] = [];
        for (let g = 0; g < RECOVERY_CODE_GROUP_COUNT; g++) {
            let group = '';
            for (let i = 0; i < RECOVERY_CODE_GROUP_SIZE; i++) {
                group +=
                    RECOVERY_CODE_ALPHABET[
                        crypto.randomInt(RECOVERY_CODE_ALPHABET.length)
                    ];
            }
            groups.push(group);
        }
        return groups.join('-');
    }

    /**
     * Generates `count` recovery codes and their bcrypt hashes. Plaintext is
     * returned once so the caller can show it; only the hashes are persisted.
     */
    async generateRecoveryCodes(
        count = this.recoveryCodeCount,
    ): Promise<{ plain: string[]; hashes: string[] }> {
        const plain = Array.from({ length: count }, () =>
            this.generateRecoveryCode(),
        );
        const hashes = await Promise.all(
            plain.map((code) => this.hashRecoveryCode(code)),
        );

        return { plain, hashes };
    }

    /** bcrypt-hashes a recovery code (dashes/case/spaces are normalized away). */
    hashRecoveryCode(code: string): Promise<string> {
        return bcrypt.hash(
            this.normalizeRecoveryCode(code),
            RECOVERY_CODE_SALT_ROUNDS,
        );
    }

    /** Constant-time-ish check of a recovery code against a stored hash. */
    verifyRecoveryCode(code: string, hash: string): Promise<boolean> {
        return bcrypt.compare(this.normalizeRecoveryCode(code), hash);
    }

    private normalizeRecoveryCode(code: string): string {
        return code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    }

    // ─── Opaque tokens ─────────────────────────────────────────────────

    /** Random URL-safe token for login challenges and setup handshakes. */
    generateOpaqueToken(): string {
        return crypto.randomBytes(OPAQUE_TOKEN_BYTES).toString('base64url');
    }

    /** SHA-256 hex digest used to store tokens without their plaintext. */
    hashToken(token: string): string {
        return crypto.createHash('sha256').update(token).digest('hex');
    }
}
