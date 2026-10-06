import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsNotEmpty,
    IsOptional,
    IsString,
    IsUrl,
    MaxLength,
} from 'class-validator';

export class WechatAuthorizeUrlDto {
    @ApiProperty({
        example: 'https://app.example.com/auth/wechat/callback',
        description:
            'The callback URL WeChat redirects to after the user scans and confirms. Must be an authorised domain of the website app.',
    })
    @IsUrl({
        protocols: ['http', 'https'],
        require_protocol: true,
        require_tld: false,
    })
    @IsNotEmpty()
    redirectUri: string;

    @ApiPropertyOptional({
        example: 'login-abc123',
        description: 'Opaque state echoed back by WeChat for CSRF protection.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(128)
    state?: string;
}
