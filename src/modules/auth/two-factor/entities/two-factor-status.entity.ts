import { ApiProperty } from '@nestjs/swagger';

/** Returned by `GET /auth/2fa/status`. Never exposes the secret or codes. */
export class TwoFactorStatusEntity {
    @ApiProperty({ example: true })
    enabled: boolean;

    @ApiProperty({ example: '2026-10-06T10:00:00.000Z', nullable: true })
    enabledAt: Date | null;

    @ApiProperty({ example: 8 })
    recoveryCodesRemaining: number;

    constructor(partial: Partial<TwoFactorStatusEntity>) {
        Object.assign(this, partial);
    }
}
