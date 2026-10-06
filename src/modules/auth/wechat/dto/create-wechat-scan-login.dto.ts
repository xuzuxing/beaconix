import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateWechatScanLoginDto {
    @ApiPropertyOptional({
        example: 'pages/login/index',
        description:
            'Mini-program page that receives the QR scene. Empty means the mini-program home page.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(128)
    page?: string;

    @ApiPropertyOptional({
        enum: ['release', 'trial', 'develop', 'developer'],
        default: 'release',
        description:
            'Mini-program environment version the QR code opens. `developer` is accepted as an alias for `develop`.',
    })
    @IsOptional()
    @IsIn(['release', 'trial', 'develop', 'developer'])
    envVersion?: 'release' | 'trial' | 'develop' | 'developer';
}
