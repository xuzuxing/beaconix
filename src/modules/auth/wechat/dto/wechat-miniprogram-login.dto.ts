import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class WechatMiniProgramLoginDto {
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
        description:
            'Optional display name captured by the mini program, used when creating a new user.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    nickname?: string;

    @ApiPropertyOptional({
        example: 'https://thirdwx.qlogo.cn/avatar',
        description:
            'Optional avatar URL captured by the mini program, used when creating a new user.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(512)
    avatarUrl?: string;
}
