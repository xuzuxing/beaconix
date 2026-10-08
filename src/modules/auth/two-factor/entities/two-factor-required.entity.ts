import { ApiProperty } from '@nestjs/swagger';

/**
 * Returned by `POST /auth/login` when the account has 2FA enabled: the
 * password was correct, but no tokens are issued until the second factor is
 * verified via `POST /auth/2fa/verify-login`.
 */
export class TwoFactorRequiredEntity {
    @ApiProperty({ example: true })
    twoFactorRequired: boolean;

    @ApiProperty({ example: 'clx123abc.raw-token' })
    challengeId: string;

    @ApiProperty({ example: '2026-10-06T10:05:00.000Z' })
    expiresAt: Date;

    constructor(partial: Partial<TwoFactorRequiredEntity>) {
        Object.assign(this, partial);
    }
}
