import { ApiProperty } from '@nestjs/swagger';

export class WechatScanLoginQrcodeEntity {
    @ApiProperty({
        example: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
        description: 'Login ticket; also carried as the QR `scene` value.',
    })
    ticket: string;

    @ApiProperty({
        example: 'data:image/png;base64,iVBORw0KGgo...',
        description: 'Mini-program QR code as a base64 data URL.',
    })
    qrCodeDataUrl: string;

    @ApiProperty({
        example: '2026-03-05T12:05:00.000Z',
        description: 'When the login ticket expires.',
    })
    expiresAt: string;

    @ApiProperty({
        example: '/api/auth/wechat/miniprogram/qrcode/status?ticket=...',
        description: 'Long-poll endpoint the web client should poll.',
    })
    pollUrl: string;

    constructor(partial: Partial<WechatScanLoginQrcodeEntity>) {
        Object.assign(this, partial);
    }
}
