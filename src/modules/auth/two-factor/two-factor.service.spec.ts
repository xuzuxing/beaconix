import * as bcrypt from 'bcrypt';
import * as QRCode from 'qrcode';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../infra/database/prisma.service';
import { TwoFactorConfig } from '../../../config';
import type { NotificationsService } from '../../notifications/notifications.service';
import { EmailTemplate } from '../../email/email.types';
import { TwoFactorCryptoService } from './two-factor-crypto.service';
import {
    RecoveryCodesEntity,
    TwoFactorRequiredEntity,
    TwoFactorSetupEntity,
} from './entities';
import { TwoFactorService } from './two-factor.service';

jest.mock('bcrypt', () => ({
    compare: jest.fn(),
    hash: jest.fn(),
}));

jest.mock('qrcode', () => ({
    toDataURL: jest.fn(),
}));

const compareMock = bcrypt.compare as jest.Mock;
const toDataUrlMock = QRCode.toDataURL as jest.Mock;

const FUTURE = new Date(Date.now() + 60_000);
const PAST = new Date(Date.now() - 60_000);

function baseUser(overrides: Record<string, unknown> = {}) {
    return {
        id: 'u1',
        email: 'john@example.com',
        name: 'John',
        password: 'hashed',
        twoFactorEnabled: false,
        twoFactorEnabledAt: null,
        deletedAt: null,
        ...overrides,
    };
}

function createService() {
    const prisma: any = {
        user: {
            findUnique: jest.fn().mockResolvedValue(baseUser()),
            update: jest.fn(),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        twoFactorChallenge: {
            create: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            deleteMany: jest.fn(),
        },
        twoFactorSecret: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
            deleteMany: jest.fn(),
        },
        twoFactorRecoveryCode: {
            findMany: jest.fn(),
            count: jest.fn(),
            createMany: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            deleteMany: jest.fn(),
        },
        refreshToken: { updateMany: jest.fn() },
        auditLog: { create: jest.fn() },
        $queryRaw: jest.fn(),
    };
    prisma.$transaction = jest.fn((cb: (tx: any) => unknown) => cb(prisma));

    const crypto: any = {
        generateTotpSecret: jest.fn().mockReturnValue('SECRET'),
        buildOtpauthUrl: jest
            .fn()
            .mockReturnValue('otpauth://totp/Beacon:john@example.com'),
        isTotpFormat: jest.fn().mockReturnValue(true),
        verifyTotp: jest.fn(),
        encryptSecret: jest.fn().mockReturnValue('enc'),
        decryptSecret: jest.fn().mockReturnValue('SECRET'),
        generateRecoveryCodes: jest.fn(),
        hashRecoveryCode: jest.fn(),
        verifyRecoveryCode: jest.fn(),
        generateOpaqueToken: jest.fn().mockReturnValue('opaque-token'),
        hashToken: jest.fn().mockReturnValue('token-hash'),
    };

    const config: TwoFactorConfig = {
        issuer: 'Beacon',
        secretKey: 'x',
        challengeTtlSeconds: 300,
        setupTtlSeconds: 600,
        maxAttempts: 5,
        recoveryCodeCount: 10,
    };
    const configService = {
        get: jest.fn().mockReturnValue(config),
    } as unknown as ConfigService;

    const notifications = {
        publish: jest.fn().mockResolvedValue(undefined),
        enqueueEmail: jest.fn().mockResolvedValue(undefined),
    };

    const service = new TwoFactorService(
        prisma as PrismaService,
        crypto as TwoFactorCryptoService,
        configService,
        notifications as unknown as NotificationsService,
    );

    return { service, prisma, crypto, notifications };
}

const meta = { ipAddress: '127.0.0.1', userAgent: 'jest' };

describe('TwoFactorService', () => {
    beforeEach(() => {
        compareMock.mockReset();
        toDataUrlMock.mockReset();
    });

    describe('createLoginChallenge', () => {
        it('persists a LOGIN challenge and returns an opaque challengeId', async () => {
            const { service, prisma, crypto } = createService();
            prisma.twoFactorChallenge.create.mockResolvedValue({ id: 'ch1' });

            const result = await service.createLoginChallenge('u1', meta);

            expect(result).toBeInstanceOf(TwoFactorRequiredEntity);
            expect(result.twoFactorRequired).toBe(true);
            expect(result.challengeId).toBe('ch1.opaque-token');
            expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
            expect(prisma.twoFactorChallenge.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    userId: 'u1',
                    purpose: 'LOGIN',
                    tokenHash: 'token-hash',
                    ipAddress: '127.0.0.1',
                }),
            });
            expect(crypto.hashToken).toHaveBeenCalledWith('opaque-token');
        });
    });

    describe('setup', () => {
        it('rejects WeChat-provisioned accounts', async () => {
            const { service, prisma } = createService();
            prisma.user.findUnique.mockResolvedValue(
                baseUser({ email: 'wx_wechat_mini_abc@wechat.local' }),
            );

            await expect(
                service.setup('u1', { currentPassword: 'x' }, meta),
            ).rejects.toMatchObject({
                response: { code: 'TWO_FACTOR_PASSWORD_REQUIRED' },
            });
        });

        it('rejects when 2FA is already enabled', async () => {
            const { service, prisma } = createService();
            prisma.user.findUnique.mockResolvedValue(
                baseUser({ twoFactorEnabled: true }),
            );

            await expect(
                service.setup('u1', { currentPassword: 'x' }, meta),
            ).rejects.toMatchObject({
                response: { code: 'TWO_FACTOR_ALREADY_ENABLED' },
            });
        });

        it('rejects a wrong current password', async () => {
            const { service, prisma } = createService();
            prisma.user.findUnique.mockResolvedValue(baseUser());
            compareMock.mockResolvedValue(false);

            await expect(
                service.setup('u1', { currentPassword: 'wrong' }, meta),
            ).rejects.toMatchObject({
                response: { code: 'INVALID_CURRENT_PASSWORD' },
            });
        });

        it('returns the QR + setup token without persisting a secret', async () => {
            const { service, prisma, crypto } = createService();
            prisma.user.findUnique.mockResolvedValue(baseUser());
            compareMock.mockResolvedValue(true);
            toDataUrlMock.mockResolvedValue('data:image/png;base64,AAA');
            prisma.twoFactorChallenge.updateMany.mockResolvedValue({
                count: 0,
            });
            prisma.twoFactorChallenge.create.mockResolvedValue({ id: 'ch1' });

            const result = await service.setup(
                'u1',
                { currentPassword: 'right' },
                meta,
            );

            expect(result).toBeInstanceOf(TwoFactorSetupEntity);
            expect(result.setupToken).toBe('opaque-token');
            expect(result.otpauthUrl).toContain('otpauth://');
            expect(result.qrCodeDataUrl).toBe('data:image/png;base64,AAA');
            expect(crypto.buildOtpauthUrl).toHaveBeenCalledWith(
                'SECRET',
                'john@example.com',
            );
            expect(prisma.twoFactorSecret.upsert).not.toHaveBeenCalled();
            expect(prisma.twoFactorChallenge.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    purpose: 'SETUP',
                    secretEnc: 'enc',
                }),
            });
        });
    });

    describe('enable', () => {
        it('rejects an unknown setup token', async () => {
            const { service, prisma } = createService();
            prisma.user.findUnique.mockResolvedValue(baseUser());
            prisma.twoFactorChallenge.findUnique.mockResolvedValue(null);

            await expect(
                service.enable('u1', { setupToken: 't', code: '123456' }, meta),
            ).rejects.toMatchObject({
                response: { code: 'INVALID_TWO_FACTOR_CHALLENGE' },
            });
        });

        it('rejects a wrong TOTP code and bumps attempts', async () => {
            const { service, prisma, crypto } = createService();
            prisma.user.findUnique.mockResolvedValue(baseUser());
            prisma.twoFactorChallenge.findUnique.mockResolvedValue({
                id: 'ch1',
                userId: 'u1',
                purpose: 'SETUP',
                secretEnc: 'enc',
                consumedAt: null,
                expiresAt: FUTURE,
                attempts: 0,
            });
            crypto.verifyTotp.mockResolvedValue(false);

            await expect(
                service.enable('u1', { setupToken: 't', code: '000000' }, meta),
            ).rejects.toMatchObject({
                response: { code: 'INVALID_TWO_FACTOR_CODE' },
            });
            expect(prisma.twoFactorChallenge.update).toHaveBeenCalledWith({
                where: { id: 'ch1' },
                data: { attempts: 1 },
            });
        });

        it('persists the secret, recovery codes, enables 2FA and revokes sessions', async () => {
            const { service, prisma, crypto, notifications } = createService();
            prisma.user.findUnique.mockResolvedValue(baseUser());
            prisma.twoFactorChallenge.findUnique.mockResolvedValue({
                id: 'ch1',
                userId: 'u1',
                purpose: 'SETUP',
                secretEnc: 'enc',
                consumedAt: null,
                expiresAt: FUTURE,
                attempts: 0,
            });
            crypto.verifyTotp.mockResolvedValue(true);
            crypto.generateRecoveryCodes.mockResolvedValue({
                plain: ['AAAA-BBBB-CCCC'],
                hashes: ['hash1'],
            });

            const result = await service.enable(
                'u1',
                { setupToken: 't', code: '123456' },
                meta,
            );

            expect(result).toBeInstanceOf(RecoveryCodesEntity);
            expect(result.recoveryCodes).toEqual(['AAAA-BBBB-CCCC']);
            expect(prisma.twoFactorSecret.upsert).toHaveBeenCalled();
            expect(
                prisma.twoFactorRecoveryCode.createMany,
            ).toHaveBeenCalledWith({
                data: [{ userId: 'u1', codeHash: 'hash1' }],
            });
            expect(prisma.user.updateMany).toHaveBeenCalledWith({
                where: { id: 'u1', twoFactorEnabled: false },
                data: expect.objectContaining({ twoFactorEnabled: true }),
            });
            expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
                where: { userId: 'u1', revokedAt: null },
                data: { revokedAt: expect.any(Date) },
            });
            expect(prisma.auditLog.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    action: 'ENABLE_2FA',
                    entity: 'UserSecurity',
                    entityId: 'u1',
                }),
            });
            expect(notifications.enqueueEmail).toHaveBeenCalledWith(
                EmailTemplate.TWO_FACTOR_ENABLED,
                expect.objectContaining({ to: 'john@example.com' }),
                'two-factor-enabled:ch1',
                prisma,
                { accessScope: 'ACCOUNT', userId: 'u1' },
            );
            expect(notifications.publish).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'TWO_FACTOR_ENABLED',
                    recipients: ['u1'],
                    includeActor: true,
                    email: false,
                }),
                prisma,
            );
            expect(
                JSON.stringify(notifications.publish.mock.calls),
            ).not.toMatch(/AAAA-BBBB-CCCC|hash1|SECRET|setupToken/);
        });
    });

    describe('verifyLogin', () => {
        function loginChallenge(overrides: Record<string, unknown> = {}) {
            return {
                id: 'ch1',
                userId: 'u1',
                purpose: 'LOGIN',
                secretEnc: null,
                consumedAt: null,
                expiresAt: FUTURE,
                attempts: 0,
                ...overrides,
            };
        }

        it('rejects an expired or unknown challenge', async () => {
            const { service, prisma } = createService();
            prisma.twoFactorChallenge.findUnique.mockResolvedValue(
                loginChallenge({ expiresAt: PAST }),
            );

            await expect(
                service.verifyLogin(
                    { challengeId: 'ch1.t', code: '123456' },
                    meta,
                ),
            ).rejects.toMatchObject({
                response: { code: 'INVALID_TWO_FACTOR_CHALLENGE' },
            });
        });

        it('rejects once attempts are exhausted', async () => {
            const { service, prisma } = createService();
            prisma.twoFactorChallenge.findUnique.mockResolvedValue(
                loginChallenge({ attempts: 5 }),
            );

            await expect(
                service.verifyLogin(
                    { challengeId: 'ch1.t', code: '123456' },
                    meta,
                ),
            ).rejects.toMatchObject({
                response: { code: 'TOO_MANY_TWO_FACTOR_ATTEMPTS' },
            });
        });

        it('accepts a valid TOTP code and consumes the challenge', async () => {
            const { service, prisma, crypto, notifications } = createService();
            prisma.twoFactorChallenge.findUnique.mockResolvedValue(
                loginChallenge(),
            );
            prisma.twoFactorSecret.findUnique.mockResolvedValue({
                secretEnc: 'enc',
            });
            crypto.isTotpFormat.mockReturnValue(true);
            crypto.verifyTotp.mockResolvedValue(true);
            prisma.user.findUnique.mockResolvedValue(baseUser());

            const result = await service.verifyLogin(
                { challengeId: 'ch1.t', code: '123456' },
                meta,
            );

            expect(result.user.id).toBe('u1');
            expect(result.recoveryCodeUsed).toBe(false);
            expect(prisma.twoFactorChallenge.updateMany).toHaveBeenCalledWith({
                where: {
                    id: 'ch1',
                    consumedAt: null,
                    expiresAt: { gt: expect.any(Date) },
                },
                data: { consumedAt: expect.any(Date) },
            });
            expect(prisma.auditLog.create).not.toHaveBeenCalled();
            expect(notifications.enqueueEmail).not.toHaveBeenCalled();
            expect(notifications.publish).not.toHaveBeenCalled();
        });

        it('accepts a recovery code once and audits its use', async () => {
            const { service, prisma, crypto, notifications } = createService();
            prisma.twoFactorChallenge.findUnique.mockResolvedValue(
                loginChallenge(),
            );
            prisma.twoFactorSecret.findUnique.mockResolvedValue({
                secretEnc: 'enc',
            });
            crypto.isTotpFormat.mockReturnValue(false);
            prisma.twoFactorRecoveryCode.findMany.mockResolvedValue([
                { id: 'rc1', codeHash: 'hash1' },
            ]);
            crypto.verifyRecoveryCode.mockResolvedValue(true);
            prisma.user.findUnique.mockResolvedValue(baseUser());

            const result = await service.verifyLogin(
                { challengeId: 'ch1.t', code: 'AAAA-BBBB-CCCC' },
                meta,
            );

            expect(result.recoveryCodeUsed).toBe(true);
            expect(
                prisma.twoFactorRecoveryCode.updateMany,
            ).toHaveBeenCalledWith({
                where: { id: 'rc1', usedAt: null },
                data: { usedAt: expect.any(Date) },
            });
            expect(prisma.auditLog.create).toHaveBeenCalledWith({
                data: expect.objectContaining({ action: 'USE_RECOVERY_CODE' }),
            });
            expect(notifications.enqueueEmail).toHaveBeenCalledWith(
                EmailTemplate.TWO_FACTOR_RECOVERY_CODE_USED,
                expect.objectContaining({ ipAddress: '127.0.0.1' }),
                'two-factor-recovery-code-used:rc1',
                prisma,
                { accessScope: 'ACCOUNT', userId: 'u1' },
            );
        });

        it('burns the challenge after the final failed attempt', async () => {
            const { service, prisma, crypto } = createService();
            prisma.twoFactorChallenge.findUnique.mockResolvedValue(
                loginChallenge({ attempts: 4 }),
            );
            prisma.twoFactorSecret.findUnique.mockResolvedValue({
                secretEnc: 'enc',
            });
            crypto.isTotpFormat.mockReturnValue(true);
            crypto.verifyTotp.mockResolvedValue(false);
            prisma.twoFactorRecoveryCode.findMany.mockResolvedValue([]);

            await expect(
                service.verifyLogin(
                    { challengeId: 'ch1.t', code: '000000' },
                    meta,
                ),
            ).rejects.toMatchObject({
                response: { code: 'INVALID_TWO_FACTOR_CODE' },
            });
            expect(prisma.twoFactorChallenge.update).toHaveBeenCalledWith({
                where: { id: 'ch1' },
                data: { attempts: 5, consumedAt: expect.any(Date) },
            });
        });
    });

    describe('disable', () => {
        it('rejects when 2FA is not enabled', async () => {
            const { service, prisma } = createService();
            prisma.user.findUnique.mockResolvedValue(baseUser());

            await expect(
                service.disable(
                    'u1',
                    { currentPassword: 'x', code: '123456' },
                    meta,
                ),
            ).rejects.toMatchObject({
                response: { code: 'TWO_FACTOR_NOT_ENABLED' },
            });
        });

        it('clears the secret, codes and sessions on success', async () => {
            const { service, prisma, crypto, notifications } = createService();
            prisma.user.findUnique.mockResolvedValue(
                baseUser({ twoFactorEnabled: true }),
            );
            compareMock.mockResolvedValue(true);
            prisma.twoFactorSecret.findUnique.mockResolvedValue({
                secretEnc: 'enc',
            });
            crypto.isTotpFormat.mockReturnValue(true);
            crypto.verifyTotp.mockResolvedValue(true);

            const result = await service.disable(
                'u1',
                { currentPassword: 'right', code: '123456' },
                meta,
            );

            expect(result.message).toContain('disabled');
            expect(prisma.twoFactorSecret.deleteMany).toHaveBeenCalledWith({
                where: { userId: 'u1' },
            });
            expect(
                prisma.twoFactorRecoveryCode.deleteMany,
            ).toHaveBeenCalledWith({ where: { userId: 'u1' } });
            expect(prisma.user.updateMany).toHaveBeenCalledWith({
                where: { id: 'u1', twoFactorEnabled: true },
                data: { twoFactorEnabled: false, twoFactorEnabledAt: null },
            });
            expect(prisma.refreshToken.updateMany).toHaveBeenCalled();
            expect(prisma.auditLog.create).toHaveBeenCalledWith({
                data: expect.objectContaining({ action: 'DISABLE_2FA' }),
            });
            expect(notifications.enqueueEmail).toHaveBeenCalledWith(
                EmailTemplate.TWO_FACTOR_DISABLED,
                expect.objectContaining({ to: 'john@example.com' }),
                expect.stringContaining('two-factor-disabled:u1:'),
                prisma,
                { accessScope: 'ACCOUNT', userId: 'u1' },
            );
        });
    });

    describe('getStatus', () => {
        it('reports disabled state with zero codes', async () => {
            const { service, prisma } = createService();
            prisma.user.findUnique.mockResolvedValue(baseUser());

            const result = await service.getStatus('u1');

            expect(result.enabled).toBe(false);
            expect(result.enabledAt).toBeNull();
            expect(result.recoveryCodesRemaining).toBe(0);
            expect(prisma.twoFactorRecoveryCode.count).not.toHaveBeenCalled();
        });

        it('reports enabled state with remaining codes', async () => {
            const { service, prisma } = createService();
            prisma.user.findUnique.mockResolvedValue(
                baseUser({
                    twoFactorEnabled: true,
                    twoFactorEnabledAt: FUTURE,
                }),
            );
            prisma.twoFactorRecoveryCode.count.mockResolvedValue(8);

            const result = await service.getStatus('u1');

            expect(result.enabled).toBe(true);
            expect(result.enabledAt).toBe(FUTURE);
            expect(result.recoveryCodesRemaining).toBe(8);
        });
    });

    describe('transactional security coverage', () => {
        function enabledService() {
            const context = createService();
            context.prisma.user.findUnique.mockResolvedValue(
                baseUser({ twoFactorEnabled: true }),
            );
            context.prisma.twoFactorSecret.findUnique.mockResolvedValue({
                secretEnc: 'enc',
            });
            context.crypto.generateRecoveryCodes.mockResolvedValue({
                plain: ['NEW-RECOVERY-CODE'],
                hashes: ['new-code-hash'],
            });
            compareMock.mockResolvedValue(true);
            return context;
        }

        it('notifies both recovery-code use and privileged regeneration without exposing codes', async () => {
            const { service, prisma, crypto, notifications } = enabledService();
            crypto.isTotpFormat.mockReturnValue(false);
            crypto.verifyRecoveryCode.mockResolvedValue(true);
            prisma.twoFactorRecoveryCode.findMany.mockResolvedValue([
                { id: 'rc1', codeHash: 'old-code-hash' },
            ]);
            await service.regenerateRecoveryCodes(
                'u1',
                { currentPassword: 'password', code: 'OLD-RECOVERY-CODE' },
                meta,
            );
            expect(
                notifications.publish.mock.calls.map(([event]) => event.type),
            ).toEqual([
                'TWO_FACTOR_RECOVERY_CODE_USED',
                'TWO_FACTOR_RECOVERY_CODES_REGENERATED',
            ]);
            expect(
                notifications.publish.mock.calls.every(
                    ([event, tx]) =>
                        event.includeActor &&
                        !event.organizationId &&
                        tx === prisma,
                ),
            ).toBe(true);
            expect(notifications.enqueueEmail).toHaveBeenCalledTimes(1);
            expect(notifications.enqueueEmail).toHaveBeenCalledWith(
                EmailTemplate.TWO_FACTOR_RECOVERY_CODE_USED,
                expect.objectContaining({ to: 'john@example.com' }),
                'two-factor-recovery-code-used:rc1',
                prisma,
                { accessScope: 'ACCOUNT', userId: 'u1' },
            );
            expect(notifications.publish.mock.calls[1][0].email).toBe(true);
            const notices = JSON.stringify(notifications.publish.mock.calls);
            expect(notices).not.toMatch(
                /NEW-RECOVERY-CODE|OLD-RECOVERY-CODE|new-code-hash|old-code-hash/,
            );
        });

        it('also sends the recovery-use alert when a recovery code disables 2FA', async () => {
            const { service, prisma, crypto, notifications } = enabledService();
            crypto.isTotpFormat.mockReturnValue(false);
            crypto.verifyRecoveryCode.mockResolvedValue(true);
            prisma.twoFactorRecoveryCode.findMany.mockResolvedValue([
                { id: 'rc1', codeHash: 'hash' },
            ]);
            await service.disable(
                'u1',
                { currentPassword: 'password', code: 'OLD-RECOVERY-CODE' },
                meta,
            );
            expect(
                notifications.publish.mock.calls.map(([event]) => event.type),
            ).toEqual(['TWO_FACTOR_RECOVERY_CODE_USED', 'TWO_FACTOR_DISABLED']);
            expect(
                notifications.enqueueEmail.mock.calls.map(
                    ([template]) => template,
                ),
            ).toEqual([
                EmailTemplate.TWO_FACTOR_RECOVERY_CODE_USED,
                EmailTemplate.TWO_FACTOR_DISABLED,
            ]);
            expect(
                notifications.enqueueEmail.mock.calls.map(
                    ([, , , , audience]) => audience,
                ),
            ).toEqual([
                { accessScope: 'ACCOUNT', userId: 'u1' },
                { accessScope: 'ACCOUNT', userId: 'u1' },
            ]);
        });

        it('rejects a recovery code already claimed concurrently without sending notices', async () => {
            const { service, prisma, crypto, notifications } = enabledService();
            crypto.isTotpFormat.mockReturnValue(false);
            crypto.verifyRecoveryCode.mockResolvedValue(true);
            prisma.twoFactorRecoveryCode.findMany.mockResolvedValue([
                { id: 'rc1', codeHash: 'hash' },
            ]);
            prisma.twoFactorRecoveryCode.updateMany.mockResolvedValue({
                count: 0,
            });
            await expect(
                service.disable(
                    'u1',
                    { currentPassword: 'password', code: 'OLD-RECOVERY-CODE' },
                    meta,
                ),
            ).rejects.toMatchObject({
                response: { code: 'INVALID_TWO_FACTOR_CODE' },
            });
            expect(notifications.publish).not.toHaveBeenCalled();
            expect(prisma.twoFactorSecret.deleteMany).not.toHaveBeenCalled();
        });

        it('propagates durable security-email failure from the mutation transaction', async () => {
            const { service, crypto, notifications } = enabledService();
            crypto.verifyTotp.mockResolvedValue(true);
            notifications.enqueueEmail.mockRejectedValue(
                new Error('outbox unavailable'),
            );
            await expect(
                service.disable(
                    'u1',
                    { currentPassword: 'password', code: '123456' },
                    meta,
                ),
            ).rejects.toThrow('outbox unavailable');
        });

        it('does not publish when 2FA has already been disabled concurrently', async () => {
            const { service, prisma, crypto, notifications } = enabledService();
            crypto.verifyTotp.mockResolvedValue(true);
            prisma.user.updateMany.mockResolvedValue({ count: 0 });
            await expect(
                service.disable(
                    'u1',
                    { currentPassword: 'password', code: '123456' },
                    meta,
                ),
            ).rejects.toMatchObject({
                response: { code: 'TWO_FACTOR_NOT_ENABLED' },
            });
            expect(notifications.publish).not.toHaveBeenCalled();
        });
    });
});
