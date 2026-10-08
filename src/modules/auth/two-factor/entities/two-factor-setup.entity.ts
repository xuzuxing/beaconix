import { ApiProperty } from '@nestjs/swagger';

/** Returned by `POST /auth/2fa/setup`: everything needed to enroll an app. */
export class TwoFactorSetupEntity {
    @ApiProperty({ example: 'opaque-setup-token' })
    setupToken: string;

    @ApiProperty({
        example:
            'otpauth://totp/Beacon:john@example.com?secret=...&issuer=Beacon',
    })
    otpauthUrl: string;

    @ApiProperty({ example: 'data:image/png;base64,iVBORw0KGgo...' })
    qrCodeDataUrl: string;

    @ApiProperty({ example: '2026-10-06T10:10:00.000Z' })
    expiresAt: Date;

    constructor(partial: Partial<TwoFactorSetupEntity>) {
        Object.assign(this, partial);
    }
}
