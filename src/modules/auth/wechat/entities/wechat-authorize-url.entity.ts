import { ApiProperty } from '@nestjs/swagger';

export class WechatAuthorizeUrlEntity {
    @ApiProperty({
        example:
            'https://open.weixin.qq.com/connect/qrconnect?appid=wx...&redirect_uri=...#wechat_redirect',
        description:
            'QR-connect URL. The web client should redirect to (or iframe) this URL to show the WeChat scan-to-login QR code.',
    })
    url: string;

    constructor(url: string) {
        this.url = url;
    }
}
