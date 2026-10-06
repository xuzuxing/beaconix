import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsNotEmpty,
    IsOptional,
    IsString,
    Length,
    MaxLength,
} from 'class-validator';

export class WechatScanLoginDto {
    @ApiProperty({
        example: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
        description: 'Login ticket carried by the mini-program QR code scene.',
    })
    @IsString()
    @IsNotEmpty()
    @Length(16, 64)
    ticket: string;

    @ApiProperty({
        example: 'CODE_FROM_WX_LOGIN',
        description: 'The temporary `code` returned by `wx.login()`.',
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(512)
    code: string;

    @ApiPropertyOptional({
        example: '张三',
        description: 'Optional display name captured by the mini program.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    nickname?: string;

    @ApiPropertyOptional({
        example: 'https://thirdwx.qlogo.cn/avatar',
        description: 'Optional avatar URL captured by the mini program.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(512)
    avatarUrl?: string;
}
