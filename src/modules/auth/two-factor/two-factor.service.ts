import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as QRCode from 'qrcode';
import { PrismaService } from '../../../infra/database/prisma.service';
import { BusinessException } from '../../../common/exceptions';
import type { RequestMeta } from '../../../common/interfaces';
import type { UserModel } from '../../../generated/prisma/models';
import { AuditAction } from '../../../generated/prisma/enums';
import { TwoFactorConfig } from '../../../config';
import { EmailService } from '../../email/email.service';
import { EmailTemplate } from '../../email/email.types';
import type { EmailPayloadMap } from '../../email/email.types';
import { TwoFactorCryptoService } from './two-factor-crypto.service';
import {
    SetupTwoFactorDto,
    EnableTwoFactorDto,
    VerifyTwoFactorLoginDto,
    DisableTwoFactorDto,
    RegenerateRecoveryCodesDto,
} from './dto';
import {
    RecoveryCodesEntity,
    TwoFactorRequiredEntity,
    TwoFactorSetupEntity,
    TwoFactorStatusEntity,
} from './entities';

const PURPOSE_LOGIN = 'LOGIN';
const PURPOSE_SETUP = 'SETUP';

/** Audit entity bucket for user-security events (not tied to an org). */
const AUDIT_ENTITY = 'UserSecurity';

/** WeChat-provisioned accounts use this placeholder domain (see WechatAuthService). */
const WECHAT_PLACEHOLDER_EMAIL_DOMAIN = '@wechat.local';

/** The 2FA security notifications this service can send. */
type SecurityEmailTemplate =
    | EmailTemplate.TWO_FACTOR_ENABLED
    | EmailTemplate.TWO_FACTOR_DISABLED
    | EmailTemplate.TWO_FACTOR_RECOVERY_CODE_USED;

/**
 * Orchestrates the 2FA flows on top of {@link TwoFactorCryptoService}: setup
 * handshake, enable, status, login verification, disable and recovery-code
 * regeneration. All persistence and audit logging lives here.
 *
 * Deliberately does NOT depend on `AuthService` (which depends on this service
 * to gate login), so token issuance stays with the caller.
 */
@Injectable()
export class TwoFactorService {
    private readonly logger = new Logger(TwoFactorService.name);
    private readonly config: TwoFactorConfig;

    constructor(
        private readonly prisma: PrismaService,
        private readonly crypto: TwoFactorCryptoService,
        private readonly configService: ConfigService,
        private readonly emailService: EmailService,
    ) {
        this.config = this.configService.get<TwoFactorConfig>('twoFactor')!;
    }

    // ─── Login gate (called by AuthService) ────────────────────────────

    /** Creates a short-lived login challenge for a user that must pass 2FA. */
    async createLoginChallenge(
        userId: string,
        meta: RequestMeta,
    ): Promise<TwoFactorRequiredEntity> {
        const token = this.crypto.generateOpaqueToken();
        const expiresAt = this.expiryFromNow(this.config.challengeTtlSeconds);

        const challenge = await this.prisma.twoFactorChallenge.create({
            data: {
                userId,
                purpose: PURPOSE_LOGIN,
                tokenHash: this.crypto.hashToken(token),
                expiresAt,
                ipAddress: meta.ipAddress,
                userAgent: meta.userAgent,
            },
        });

        return new TwoFactorRequiredEntity({
            twoFactorRequired: true,
            challengeId: `${challenge.id}.${token}`,
            expiresAt,
        });
    }

    // ─── Enrollment ────────────────────────────────────────────────────

    /** Starts enrollment: validates the password and returns a QR + setup token. */
    async setup(
        userId: string,
        dto: SetupTwoFactorDto,
        meta: RequestMeta,
    ): Promise<TwoFactorSetupEntity> {
        const user = await this.getUser(userId);
        this.assertPasswordBasedAccount(user);

        if (user.twoFactorEnabled) {
            throw this.alreadyEnabled();
        }

        await this.assertPassword(user, dto.currentPassword);

        const secret = this.crypto.generateTotpSecret();
        const setupToken = this.crypto.generateOpaqueToken();
        const expiresAt = this.expiryFromNow(this.config.setupTtlSeconds);

        // Only one pending handshake per user — retire any earlier one.
        await this.prisma.twoFactorChallenge.updateMany({
            where: {
                userId,
                purpose: PURPOSE_SETUP,
                consumedAt: null,
            },
            data: { consumedAt: new Date() },
        });

        // The secret is NOT persisted yet; it rides on the setup challenge
        // (encrypted) until the user proves possession of the code.
        await this.prisma.twoFactorChallenge.create({
            data: {
                userId,
                purpose: PURPOSE_SETUP,
                tokenHash: this.crypto.hashToken(setupToken),
                secretEnc: this.crypto.encryptSecret(secret),
                expiresAt,
                ipAddress: meta.ipAddress,
                userAgent: meta.userAgent,
            },
        });

        const otpauthUrl = this.crypto.buildOtpauthUrl(secret, user.email);
        const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

        return new TwoFactorSetupEntity({
            setupToken,
            otpauthUrl,
            qrCodeDataUrl,
            expiresAt,
        });
    }

    /** Confirms enrollment: verifies the setup token + TOTP, persists the secret. */
    async enable(
        userId: string,
        dto: EnableTwoFactorDto,
        meta: RequestMeta,
    ): Promise<RecoveryCodesEntity> {
        const user = await this.getUser(userId);
        this.assertPasswordBasedAccount(user);

        if (user.twoFactorEnabled) {
            throw this.alreadyEnabled();
        }

        const challenge = await this.loadChallenge(
            userId,
            PURPOSE_SETUP,
            dto.setupToken,
        );
        if (!challenge.secretEnc) {
            throw this.invalidChallenge();
        }

        const secret = this.crypto.decryptSecret(challenge.secretEnc);
        if (!(await this.crypto.verifyTotp(secret, dto.code))) {
            await this.registerFailedAttempt(challenge.id, challenge.attempts);
            throw this.invalidCode();
        }

        const { plain, hashes } = await this.crypto.generateRecoveryCodes();
        const secretEnc = this.crypto.encryptSecret(secret);

        await this.prisma.$transaction(async (tx) => {
            await tx.twoFactorSecret.upsert({
                where: { userId },
                update: { secretEnc },
                create: { userId, secretEnc },
            });
            await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
            await tx.twoFactorRecoveryCode.createMany({
                data: hashes.map((codeHash) => ({ userId, codeHash })),
            });
            await tx.user.update({
                where: { id: userId },
                data: {
                    twoFactorEnabled: true,
                    twoFactorEnabledAt: new Date(),
                },
            });
            await tx.twoFactorChallenge.update({
                where: { id: challenge.id },
                data: { consumedAt: new Date() },
            });
            // Every other session must come back through the second factor.
            await tx.refreshToken.updateMany({
                where: { userId, revokedAt: null },
                data: { revokedAt: new Date() },
            });
        });

        await this.writeAudit(userId, AuditAction.ENABLE_2FA, meta);

        this.sendSecurityEmail(user, EmailTemplate.TWO_FACTOR_ENABLED, {
            changedAt: new Date().toISOString(),
        });

        return new RecoveryCodesEntity({ recoveryCodes: plain });
    }

    /** Current 2FA status. Never exposes the secret or recovery code material. */
    async getStatus(userId: string): Promise<TwoFactorStatusEntity> {
        const user = await this.getUser(userId);

        const recoveryCodesRemaining = user.twoFactorEnabled
            ? await this.prisma.twoFactorRecoveryCode.count({
                  where: { userId, usedAt: null },
              })
            : 0;

        return new TwoFactorStatusEntity({
            enabled: user.twoFactorEnabled,
            enabledAt: user.twoFactorEnabledAt,
            recoveryCodesRemaining,
        });
    }

    // ─── Second step of login ──────────────────────────────────────────

    /**
     * Verifies a login challenge with a TOTP code or a recovery code, consuming
     * the challenge on success. Returns the user so the caller can issue tokens.
     */
    async verifyLogin(
        dto: VerifyTwoFactorLoginDto,
        meta: RequestMeta,
    ): Promise<{ user: UserModel; recoveryCodeUsed: boolean }> {
        const rawToken = this.extractChallengeToken(dto.challengeId);

        const challenge = await this.prisma.twoFactorChallenge.findUnique({
            where: { tokenHash: this.crypto.hashToken(rawToken) },
        });

        if (
            !challenge ||
            challenge.purpose !== PURPOSE_LOGIN ||
            challenge.consumedAt ||
            challenge.expiresAt <= new Date()
        ) {
            throw this.invalidChallenge();
        }
        if (challenge.attempts >= this.config.maxAttempts) {
            throw this.tooManyAttempts();
        }

        let verified = false;
        let recoveryCodeUsed = false;

        const secret = await this.getSecretPlaintext(challenge.userId);
        if (secret && this.crypto.isTotpFormat(dto.code)) {
            verified = await this.crypto.verifyTotp(secret, dto.code);
        }
        if (!verified) {
            recoveryCodeUsed = await this.tryConsumeRecoveryCode(
                challenge.userId,
                dto.code,
            );
            verified = recoveryCodeUsed;
        }

        if (!verified) {
            await this.registerFailedAttempt(challenge.id, challenge.attempts);
            throw this.invalidCode();
        }

        await this.prisma.twoFactorChallenge.update({
            where: { id: challenge.id },
            data: { consumedAt: new Date() },
        });

        if (recoveryCodeUsed) {
            await this.writeAudit(
                challenge.userId,
                AuditAction.USE_RECOVERY_CODE,
                meta,
            );
        }

        const user = await this.getUser(challenge.userId);

        if (recoveryCodeUsed) {
            this.sendSecurityEmail(
                user,
                EmailTemplate.TWO_FACTOR_RECOVERY_CODE_USED,
                {
                    usedAt: new Date().toISOString(),
                    ipAddress: meta.ipAddress ?? 'unknown',
                },
            );
        }

        return { user, recoveryCodeUsed };
    }

    // ─── Recovery codes & disable ──────────────────────────────────────

    /** Rotates recovery codes; old codes are dropped. Does not touch sessions. */
    async regenerateRecoveryCodes(
        userId: string,
        dto: RegenerateRecoveryCodesDto,
        meta: RequestMeta,
    ): Promise<RecoveryCodesEntity> {
        const user = await this.getUser(userId);
        this.assertPasswordBasedAccount(user);
        this.assertEnabled(user);

        await this.assertPassword(user, dto.currentPassword);
        await this.assertSecondFactor(userId, dto.code);

        const { plain, hashes } = await this.crypto.generateRecoveryCodes();

        await this.prisma.$transaction(async (tx) => {
            await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
            await tx.twoFactorRecoveryCode.createMany({
                data: hashes.map((codeHash) => ({ userId, codeHash })),
            });
        });

        await this.writeAudit(
            userId,
            AuditAction.REGENERATE_RECOVERY_CODES,
            meta,
        );

        return new RecoveryCodesEntity({ recoveryCodes: plain });
    }

    /** Turns 2FA off and revokes every session (including the current one). */
    async disable(
        userId: string,
        dto: DisableTwoFactorDto,
        meta: RequestMeta,
    ): Promise<{ message: string }> {
        const user = await this.getUser(userId);
        this.assertPasswordBasedAccount(user);
        this.assertEnabled(user);

        await this.assertPassword(user, dto.currentPassword);
        await this.assertSecondFactor(userId, dto.code);

        await this.prisma.$transaction(async (tx) => {
            await tx.twoFactorSecret.deleteMany({ where: { userId } });
            await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
            await tx.twoFactorChallenge.deleteMany({ where: { userId } });
            await tx.user.update({
                where: { id: userId },
                data: { twoFactorEnabled: false, twoFactorEnabledAt: null },
            });
            await tx.refreshToken.updateMany({
                where: { userId, revokedAt: null },
                data: { revokedAt: new Date() },
            });
        });

        await this.writeAudit(userId, AuditAction.DISABLE_2FA, meta);

        this.sendSecurityEmail(user, EmailTemplate.TWO_FACTOR_DISABLED, {
            changedAt: new Date().toISOString(),
        });

        return { message: 'Two-factor authentication has been disabled.' };
    }

    // ─── Helpers ───────────────────────────────────────────────────────

    private async getUser(userId: string): Promise<UserModel> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
        });
        if (!user || user.deletedAt) {
            throw new BusinessException(
                HttpStatus.NOT_FOUND,
                'USER_NOT_FOUND',
                'User not found',
            );
        }
        return user;
    }

    /**
     * WeChat-provisioned accounts hold a random, unknown password, so they can
     * never satisfy a `currentPassword` check. Reject them explicitly.
     */
    private assertPasswordBasedAccount(user: UserModel): void {
        if (user.email.endsWith(WECHAT_PLACEHOLDER_EMAIL_DOMAIN)) {
            throw new BusinessException(
                HttpStatus.BAD_REQUEST,
                'TWO_FACTOR_PASSWORD_REQUIRED',
                'Set a password before managing two-factor authentication',
            );
        }
    }

    private assertEnabled(user: UserModel): void {
        if (!user.twoFactorEnabled) {
            throw new BusinessException(
                HttpStatus.BAD_REQUEST,
                'TWO_FACTOR_NOT_ENABLED',
                'Two-factor authentication is not enabled',
            );
        }
    }

    private async assertPassword(
        user: UserModel,
        password: string,
    ): Promise<void> {
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            throw new BusinessException(
                HttpStatus.UNAUTHORIZED,
                'INVALID_CURRENT_PASSWORD',
                'Current password is incorrect',
            );
        }
    }

    /** Accepts either a valid TOTP code or a valid unused recovery code. */
    private async assertSecondFactor(
        userId: string,
        code: string,
    ): Promise<void> {
        const secret = await this.getSecretPlaintext(userId);
        if (
            secret &&
            this.crypto.isTotpFormat(code) &&
            (await this.crypto.verifyTotp(secret, code))
        ) {
            return;
        }
        if (await this.tryConsumeRecoveryCode(userId, code)) {
            return;
        }
        throw this.invalidCode();
    }

    private async getSecretPlaintext(userId: string): Promise<string | null> {
        const record = await this.prisma.twoFactorSecret.findUnique({
            where: { userId },
        });
        if (!record) return null;

        try {
            return this.crypto.decryptSecret(record.secretEnc);
        } catch (error) {
            this.logger.error(
                `Failed to decrypt 2FA secret for user ${userId}`,
                error as Error,
            );
            throw new BusinessException(
                HttpStatus.INTERNAL_SERVER_ERROR,
                'TWO_FACTOR_SECRET_UNREADABLE',
                'Unable to read two-factor secret',
            );
        }
    }

    private async loadChallenge(
        userId: string,
        purpose: string,
        rawToken: string,
    ) {
        const challenge = await this.prisma.twoFactorChallenge.findUnique({
            where: { tokenHash: this.crypto.hashToken(rawToken) },
        });

        if (
            !challenge ||
            challenge.userId !== userId ||
            challenge.purpose !== purpose ||
            challenge.consumedAt ||
            challenge.expiresAt <= new Date()
        ) {
            throw this.invalidChallenge();
        }
        if (challenge.attempts >= this.config.maxAttempts) {
            throw this.tooManyAttempts();
        }

        return challenge;
    }

    /** Finds and burns a matching unused recovery code, if any. */
    private async tryConsumeRecoveryCode(
        userId: string,
        code: string,
    ): Promise<boolean> {
        // A 6-digit token can never be a (grouped) recovery code.
        if (this.crypto.isTotpFormat(code)) return false;

        const candidates = await this.prisma.twoFactorRecoveryCode.findMany({
            where: { userId, usedAt: null },
            orderBy: { createdAt: 'asc' },
        });

        for (const candidate of candidates) {
            if (
                await this.crypto.verifyRecoveryCode(code, candidate.codeHash)
            ) {
                await this.prisma.twoFactorRecoveryCode.update({
                    where: { id: candidate.id },
                    data: { usedAt: new Date() },
                });
                return true;
            }
        }

        return false;
    }

    private async registerFailedAttempt(
        challengeId: string,
        attempts: number,
    ): Promise<void> {
        const nextAttempts = attempts + 1;
        const burn = nextAttempts >= this.config.maxAttempts;

        await this.prisma.twoFactorChallenge.update({
            where: { id: challengeId },
            data: {
                attempts: nextAttempts,
                ...(burn ? { consumedAt: new Date() } : {}),
            },
        });
    }

    private extractChallengeToken(challengeId: string): string {
        const separatorIndex = challengeId.indexOf('.');
        return separatorIndex >= 0
            ? challengeId.slice(separatorIndex + 1)
            : challengeId;
    }

    private expiryFromNow(seconds: number): Date {
        return new Date(Date.now() + seconds * 1000);
    }

    private async writeAudit(
        userId: string,
        action: AuditAction,
        meta: RequestMeta,
    ): Promise<void> {
        try {
            await this.prisma.auditLog.create({
                data: {
                    actorId: userId,
                    organizationId: null,
                    projectId: null,
                    action,
                    entity: AUDIT_ENTITY,
                    entityId: userId,
                    ipAddress: meta.ipAddress,
                    userAgent: meta.userAgent,
                },
            });
        } catch (error) {
            // Never fail the request because auditing failed.
            this.logger.error('Failed to write 2FA audit log', error as Error);
        }
    }

    /**
     * Fire-and-forget security notification. Never blocks or fails the request;
     * delivery problems are logged only.
     */
    private sendSecurityEmail<T extends SecurityEmailTemplate>(
        user: UserModel,
        template: T,
        data: Omit<EmailPayloadMap[T], 'to' | 'name'>,
    ): void {
        const payload = {
            to: user.email,
            name: user.name,
            ...data,
        } as EmailPayloadMap[T];

        void this.emailService.send(template, payload).catch((error) => {
            this.logger.error(
                `Failed to send 2FA security email "${template}"`,
                error as Error,
            );
        });
    }

    private alreadyEnabled(): BusinessException {
        return new BusinessException(
            HttpStatus.CONFLICT,
            'TWO_FACTOR_ALREADY_ENABLED',
            'Two-factor authentication is already enabled',
        );
    }

    private invalidChallenge(): BusinessException {
        return new BusinessException(
            HttpStatus.UNAUTHORIZED,
            'INVALID_TWO_FACTOR_CHALLENGE',
            'Invalid or expired two-factor challenge',
        );
    }

    private invalidCode(): BusinessException {
        return new BusinessException(
            HttpStatus.UNAUTHORIZED,
            'INVALID_TWO_FACTOR_CODE',
            'Invalid or expired two-factor code',
        );
    }

    private tooManyAttempts(): BusinessException {
        return new BusinessException(
            HttpStatus.TOO_MANY_REQUESTS,
            'TOO_MANY_TWO_FACTOR_ATTEMPTS',
            'Too many failed attempts. Please log in again.',
        );
    }
}
