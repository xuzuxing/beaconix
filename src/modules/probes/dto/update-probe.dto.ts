import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsBoolean,
    IsEnum,
    IsOptional,
    IsString,
    IsUrl,
    MaxLength,
    MinLength,
} from 'class-validator';
import { ProbeProvider } from '../../../generated/prisma/enums';

export class UpdateProbeDto {
    @ApiPropertyOptional({ example: 'Tokyo probe (rotated)' })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name?: string;

    @ApiPropertyOptional({
        enum: ProbeProvider,
        example: ProbeProvider.ALIYUN,
    })
    @IsOptional()
    @IsEnum(ProbeProvider)
    provider?: ProbeProvider;

    @ApiPropertyOptional({ example: 'cn-hangzhou' })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    region?: string;

    @ApiPropertyOptional({ example: 'https://probe.example.com/beacon/cb' })
    @IsOptional()
    @IsUrl({ require_tld: false })
    @MaxLength(2048)
    callbackUrl?: string;

    @ApiPropertyOptional({ example: false })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;
}
