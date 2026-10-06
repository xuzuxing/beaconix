import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class WechatWebLoginDto {
    @ApiProperty({
        example: 'CODE_FROM_WECHAT_QR_CONNECT_REDIRECT',
        description:
            'The `code` query parameter WeChat appended to the redirect URL after a successful scan.',
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(512)
    code: string;
}
