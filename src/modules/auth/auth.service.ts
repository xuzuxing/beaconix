import {
    Injectable,
    ConflictException,
    UnauthorizedException,
    ForbiddenException,
    BadRequestException,
    Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../../infra/database/prisma.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { EmailService } from '../email/email.service';
import { EmailTemplate } from '../email/email.types';
import type { UserModel } from '../../generated/prisma/models';
import { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { JwtConfig } from '../../config';
import {
    generateSecureOtp,
    hashOtp,
    verifyOtp,
    getOtpExpiryDate,
    OTP_EXPIRY_MINUTES,
    OTP_MAX_ATTEMPTS,
} from '../../common/utils/otp.util';
import {
    RegisterDto,
    LoginDto,
    RefreshTokenDto,
    UpdateProfileDto,
    ChangePasswordDto,
    VerifyEmailDto,
    ResendOtpDto,
    ForgotPasswordDto,
    ResetPasswordDto,
} from './dto';
import { UserEntity } from './entities';
import { TwoFactorService } from './two-factor/two-factor.service';
import type { RequestMeta } from '../../common/interfaces';

@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);
    private readonly jwtConfig: JwtConfig;

    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
        private readonly emailService: EmailService,
        private readonly organizationsService: OrganizationsService,
        private readonly twoFactorService: TwoFactorService,
    ) {
        this.jwtConfig = this.configService.get<JwtConfig>('jwt')!;
    }

    async register(dto: RegisterDto) {
        const existing = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });
        if (existing) {
            throw new ConflictException('Email already registered');
        }

        const hashedPassword = await bcrypt.hash(dto.password, 12);

        const user = await this.prisma.user.create({
            data: {
                email: dto.email,
                password: hashedPassword,
                name: dto.name,
            },
        });

        // Generate and send email verification OTP
        await this.createAndSendOtp(
            user.id,
            user.email,
            user.name,
            'EMAIL_VERIFICATION',
        );

        this.logger.log(`User registered: ${this.maskEmail(user.email)}`);

        return {
            message:
                'Registration successful. Please check your email for the verification code.',
            user: new UserEntity(user),
        };
    }

    async login(dto: LoginDto, meta: RequestMeta) {
        const user = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });
        if (!user) {
            throw new UnauthorizedException('Invalid credentials');
        }
        if (!user.isActive) {
            throw new ForbiddenException('Account is deactivated');
        }
        if (user.deletedAt) {
            throw new UnauthorizedException('Invalid credentials');
        }
        if (!user.emailVerified) {
            throw new ForbiddenException(
                'Email not verified. Please verify your email before logging in.',
            );
        }

        const passwordValid = await bcrypt.compare(dto.password, user.password);
        if (!passwordValid) {
            throw new UnauthorizedException('Invalid credentials');
        }

        this.logger.log(`User logged in: ${this.maskEmail(user.email)}`);

        return this.issueTokensOrChallenge(user, meta);
    }

    async refresh(dto: RefreshTokenDto) {
        const tokenHash = this.hashToken(dto.refreshToken);

        const storedToken = await this.prisma.refreshToken.findUnique({
            where: { token: tokenHash },
            include: { user: true },
        });

        if (!storedToken) {
            throw new UnauthorizedException('Invalid refresh token');
        }
        if (storedToken.revokedAt) {
            throw new UnauthorizedException('Refresh token has been revoked');
        }
        if (storedToken.expiresAt < new Date()) {
            throw new UnauthorizedException('Refresh token has expired');
        }
        if (!storedToken.user.isActive) {
            throw new ForbiddenException('Account is deactivated');
        }

        // Rotate: revoke old token
        await this.prisma.refreshToken.update({
            where: { id: storedToken.id },
            data: { revokedAt: new Date() },
        });

        // Issue new tokens
        const { user } = storedToken;
        const tokens = await this.generateTokens(
            user.id,
            user.email,
            user.globalRole,
        );
        await this.storeRefreshToken(user.id, tokens.refreshToken);

        return {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            user: new UserEntity(user),
        };
    }

    async logout(dto: RefreshTokenDto) {
        const tokenHash = this.hashToken(dto.refreshToken);

        const storedToken = await this.prisma.refreshToken.findUnique({
            where: { token: tokenHash },
        });

        if (storedToken && !storedToken.revokedAt) {
            await this.prisma.refreshToken.update({
                where: { id: storedToken.id },
                data: { revokedAt: new Date() },
            });
        }
    }

    async getMe(userId: string) {
        const user = await this.prisma.user.findUniqueOrThrow({
            where: { id: userId },
        });
        return new UserEntity(user);
    }

    async updateProfile(userId: string, dto: UpdateProfileDto) {
        const user = await this.prisma.user.update({
            where: { id: userId },
            data: dto,
        });
        return new UserEntity(user);
    }

    async changePassword(userId: string, dto: ChangePasswordDto) {
        const user = await this.prisma.user.findUniqueOrThrow({
            where: { id: userId },
        });

        const passwordValid = await bcrypt.compare(
            dto.currentPassword,
            user.password,
        );
        if (!passwordValid) {
            throw new UnauthorizedException('Current password is incorrect');
        }

        const hashedPassword = await bcrypt.hash(dto.newPassword, 12);

        await this.prisma.user.update({
            where: { id: userId },
            data: { password: hashedPassword },
        });

        // Revoke all refresh tokens on password change
        await this.prisma.refreshToken.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: new Date() },
        });
    }

    // ─── Email Verification ────────────────────────────────────────────

    async verifyEmail(dto: VerifyEmailDto) {
        const user = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });
        if (!user) {
            throw new BadRequestException('Invalid email or code');
        }
        if (user.emailVerified) {
            throw new BadRequestException('Email is already verified');
        }

        await this.verifyOtpCode(user.id, dto.code, 'EMAIL_VERIFICATION');

        // Mark the account verified and provision the starter organization in a
        // single transaction: either the user ends up with an organization and
        // a project, or nothing is written and they can request a fresh code.
        await this.prisma.$transaction(async (tx) => {
            await tx.user.update({
                where: { id: user.id },
                data: { emailVerified: true },
            });

            await this.organizationsService.provisionForUser(user, tx);
        });

        // Generate tokens so user is logged in after verification
        const tokens = await this.generateTokens(
            user.id,
            user.email,
            user.globalRole,
        );
        await this.storeRefreshToken(user.id, tokens.refreshToken);

        this.logger.log(
            `Email verified for user: ${this.maskEmail(user.email)}`,
        );

        return {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            user: new UserEntity({ ...user, emailVerified: true }),
        };
    }

    async resendVerificationOtp(dto: ResendOtpDto) {
        const user = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });

        // Always return success to prevent email enumeration
        if (!user || user.emailVerified) {
            return {
                message:
                    'If your email is registered and not yet verified, you will receive a verification code.',
            };
        }

        await this.createAndSendOtp(
            user.id,
            user.email,
            user.name,
            'EMAIL_VERIFICATION',
        );

        return {
            message:
                'If your email is registered and not yet verified, you will receive a verification code.',
        };
    }

    // ─── Forgot / Reset Password ──────────────────────────────────────

    async forgotPassword(dto: ForgotPasswordDto) {
        const user = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });

        // Always return success to prevent email enumeration
        if (!user || user.deletedAt || !user.isActive) {
            return {
                message:
                    'If your email is registered, you will receive a password reset code.',
            };
        }

        await this.createAndSendOtp(
            user.id,
            user.email,
            user.name,
            'PASSWORD_RESET',
        );

        return {
            message:
                'If your email is registered, you will receive a password reset code.',
        };
    }

    async resetPassword(dto: ResetPasswordDto) {
        const user = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });
        if (!user) {
            throw new BadRequestException('Invalid email or code');
        }

        await this.verifyOtpCode(user.id, dto.code, 'PASSWORD_RESET');

        const hashedPassword = await bcrypt.hash(dto.newPassword, 12);

        await this.prisma.user.update({
            where: { id: user.id },
            data: { password: hashedPassword },
        });

        // Revoke all refresh tokens on password reset
        await this.prisma.refreshToken.updateMany({
            where: { userId: user.id, revokedAt: null },
            data: { revokedAt: new Date() },
        });

        this.logger.log(
            `Password reset for user: ${this.maskEmail(user.email)}`,
        );

        return { message: 'Password has been reset successfully.' };
    }

    /**
     * Issues auth tokens + user for an already-resolved user, used by the
     * WeChat login flow (and reusable by other social-login providers later).
     */
    async issueTokensForUser(user: UserModel) {
        const tokens = await this.generateTokens(
            user.id,
            user.email,
            user.globalRole,
        );
        await this.storeRefreshToken(user.id, tokens.refreshToken);

        await this.prisma.user.update({
            where: { id: user.id },
            data: { lastSeenAt: new Date() },
        });

        return {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            user: new UserEntity(user),
        };
    }

    /**
     * Single gate for every token-issuing path. When the account has 2FA
     * enabled, a short-lived challenge is returned instead of tokens so the
     * second factor must be passed (see `TwoFactorService.verifyLogin`).
     */
    async issueTokensOrChallenge(user: UserModel, meta: RequestMeta) {
        if (user.twoFactorEnabled) {
            return this.twoFactorService.createLoginChallenge(user.id, meta);
        }

        return this.issueTokensForUser(user);
    }

    // ─── Private Helpers ───────────────────────────────────────────────

    private async generateTokens(
        userId: string,
        email: string,
        globalRole: string,
    ) {
        const payload: JwtPayload = {
            sub: userId,
            email,
            globalRole: globalRole as JwtPayload['globalRole'],
        };

        const accessToken = await this.jwtService.signAsync(payload);
        const refreshToken = crypto.randomBytes(64).toString('hex');

        return { accessToken, refreshToken };
    }

    private async storeRefreshToken(userId: string, rawToken: string) {
        const tokenHash = this.hashToken(rawToken);
        const expiresAt = this.calculateRefreshExpiry();

        await this.prisma.refreshToken.create({
            data: {
                userId,
                token: tokenHash,
                expiresAt,
            },
        });
    }

    private maskEmail(email: string): string {
        return email.replace(/^(..)[^@]*/, '$1***');
    }

    private hashToken(token: string): string {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    private calculateRefreshExpiry(): Date {
        const expiresIn = this.jwtConfig.refreshExpiresIn;
        const ms = this.parseDuration(expiresIn);
        return new Date(Date.now() + ms);
    }

    private parseDuration(duration: string): number {
        const match = duration.match(/^(\d+)([smhd])$/);
        if (!match) return 7 * 24 * 60 * 60 * 1000; // default 7 days

        const value = parseInt(match[1], 10);
        const unit = match[2];

        const multipliers: Record<string, number> = {
            s: 1000,
            m: 60 * 1000,
            h: 60 * 60 * 1000,
            d: 24 * 60 * 60 * 1000,
        };

        return value * (multipliers[unit] ?? 24 * 60 * 60 * 1000);
    }

    // ─── OTP Helpers ───────────────────────────────────────────────────

    private async createAndSendOtp(
        userId: string,
        email: string,
        name: string,
        purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
    ): Promise<void> {
        // Invalidate any existing unused OTPs for this user + purpose
        await this.prisma.otpCode.updateMany({
            where: { userId, purpose, usedAt: null },
            data: { usedAt: new Date() },
        });

        const otp = generateSecureOtp();
        const codeHash = await hashOtp(otp);

        await this.prisma.otpCode.create({
            data: {
                userId,
                codeHash,
                purpose,
                expiresAt: getOtpExpiryDate(),
            },
        });

        const template =
            purpose === 'EMAIL_VERIFICATION'
                ? EmailTemplate.EMAIL_VERIFICATION
                : EmailTemplate.PASSWORD_RESET_OTP;

        await this.emailService.send(template, {
            to: email,
            name,
            code: otp,
            expiresInMinutes: OTP_EXPIRY_MINUTES,
        });
    }

    private async verifyOtpCode(
        userId: string,
        code: string,
        purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
    ): Promise<void> {
        // Get the latest unused, non-expired OTP for this user + purpose
        const otpRecord = await this.prisma.otpCode.findFirst({
            where: {
                userId,
                purpose,
                usedAt: null,
                expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: 'desc' },
        });

        if (!otpRecord) {
            throw new BadRequestException(
                'Invalid or expired code. Please request a new one.',
            );
        }

        if (otpRecord.attempts >= OTP_MAX_ATTEMPTS) {
            // Mark as used to prevent further attempts
            await this.prisma.otpCode.update({
                where: { id: otpRecord.id },
                data: { usedAt: new Date() },
            });
            throw new BadRequestException(
                'Too many failed attempts. Please request a new code.',
            );
        }

        const isValid = await verifyOtp(code, otpRecord.codeHash);

        if (!isValid) {
            // Increment attempt counter
            await this.prisma.otpCode.update({
                where: { id: otpRecord.id },
                data: { attempts: { increment: 1 } },
            });
            throw new BadRequestException('Invalid or expired code.');
        }

        // Mark OTP as used
        await this.prisma.otpCode.update({
            where: { id: otpRecord.id },
            data: { usedAt: new Date() },
        });
    }
}
