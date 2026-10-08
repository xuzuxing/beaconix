import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { generate } from 'otplib';
import { TwoFactorConfig } from '../../../config';
import { TwoFactorCryptoService } from './two-factor-crypto.service';

const SECRET_KEY = '24uY4WGRdX46mdIdCPHP74TIZSF46VjqyLSzhxqqCo4=';
const OTHER_KEY = crypto.randomBytes(32).toString('base64');
const RECOVERY_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function buildService(secretKey = SECRET_KEY): TwoFactorCryptoService {
    const config: TwoFactorConfig = {
        issuer: 'Beacon',
        secretKey,
        challengeTtlSeconds: 300,
        setupTtlSeconds: 600,
        maxAttempts: 5,
        recoveryCodeCount: 10,
    };
    const configService = {
        get: () => config,
    } as unknown as ConfigService;

    return new TwoFactorCryptoService(configService);
}

describe('TwoFactorCryptoService', () => {
    let service: TwoFactorCryptoService;

    beforeEach(() => {
        service = buildService();
    });

    it('rejects a key that does not decode to 32 bytes', () => {
        expect(() => buildService('tooshort')).toThrow();
    });

    describe('secret encryption', () => {
        it('round-trips a secret', () => {
            const plain = 'JBSWY3DPEHPK3PXP';
            const encrypted = service.encryptSecret(plain);

            expect(encrypted).toMatch(/^v1:/);
            expect(encrypted).not.toContain(plain);
            expect(service.decryptSecret(encrypted)).toBe(plain);
        });

        it('fails to decrypt with a different key', () => {
            const encrypted = service.encryptSecret('JBSWY3DPEHPK3PXP');
            const other = buildService(OTHER_KEY);

            expect(() => other.decryptSecret(encrypted)).toThrow();
        });

        it('fails to decrypt a tampered payload', () => {
            const encrypted = service.encryptSecret('JBSWY3DPEHPK3PXP');
            const [, iv, tag, data] = encrypted.split(':');
            const tampered = ['v1', iv, tag, `${data.slice(0, -2)}AB`].join(
                ':',
            );

            expect(() => service.decryptSecret(tampered)).toThrow();
        });

        it('rejects an unknown payload version', () => {
            expect(() => service.decryptSecret('v9:a:b:c')).toThrow();
        });
    });

    describe('TOTP', () => {
        it('generates a Base32 secret', () => {
            expect(service.generateTotpSecret()).toMatch(/^[A-Z2-7]+$/);
        });

        it('builds an otpauth URI carrying the issuer and label', () => {
            const uri = service.buildOtpauthUrl(
                'JBSWY3DPEHPK3PXP',
                'john@example.com',
            );

            expect(uri).toContain('otpauth://totp/');
            expect(uri).toContain('issuer=Beacon');
            expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
        });

        it('verifies a freshly generated token and rejects a wrong one', async () => {
            const secret = service.generateTotpSecret();
            const token = await generate({ secret });

            await expect(service.verifyTotp(secret, token)).resolves.toBe(true);
            await expect(service.verifyTotp(secret, '000000')).resolves.toBe(
                false,
            );
            await expect(
                service.verifyTotp(secret, 'not-6-digits'),
            ).resolves.toBe(false);
        });

        it('classifies TOTP vs recovery-code shapes', () => {
            expect(service.isTotpFormat('123456')).toBe(true);
            expect(service.isTotpFormat('8H2K-M4XD-9PQA')).toBe(false);
            expect(service.isTotpFormat('12345')).toBe(false);
        });
    });

    describe('recovery codes', () => {
        it('formats codes as xxxx-xxxx-xxxx', () => {
            expect(service.generateRecoveryCode()).toMatch(
                RECOVERY_CODE_PATTERN,
            );
        });

        it('generates the configured number of unique codes with hashes', async () => {
            const { plain, hashes } = await service.generateRecoveryCodes();

            expect(plain).toHaveLength(10);
            expect(hashes).toHaveLength(10);
            expect(new Set(plain).size).toBe(plain.length);
        });

        it('verifies the matching code and normalizes case/formatting', async () => {
            const { plain, hashes } = await service.generateRecoveryCodes(1);
            const code = plain[0];
            const hash = hashes[0];

            await expect(service.verifyRecoveryCode(code, hash)).resolves.toBe(
                true,
            );
            await expect(
                service.verifyRecoveryCode(code.toLowerCase(), hash),
            ).resolves.toBe(true);
            await expect(
                service.verifyRecoveryCode(code.replace(/-/g, ''), hash),
            ).resolves.toBe(true);
            await expect(
                service.verifyRecoveryCode('ZZZZ-ZZZZ-ZZZZ', hash),
            ).resolves.toBe(false);
        });
    });

    describe('opaque tokens', () => {
        it('hashes tokens deterministically and irreversibly', () => {
            const token = service.generateOpaqueToken();
            const hash = service.hashToken(token);

            expect(hash).toHaveLength(64);
            expect(hash).toBe(service.hashToken(token));
            expect(hash).not.toContain(token);
        });

        it('produces distinct tokens', () => {
            expect(service.generateOpaqueToken()).not.toBe(
                service.generateOpaqueToken(),
            );
        });
    });
});
