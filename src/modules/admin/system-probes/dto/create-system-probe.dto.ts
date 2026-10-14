import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsBoolean,
    IsEnum,
    IsInt,
    IsOptional,
    IsString,
    IsUrl,
    Max,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';
import { ProbeProvider } from '../../../../generated/prisma/enums';

export class CreateSystemProbeDto {
    @ApiProperty({ example: 'Global Tokyo probe' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name: string;

    @ApiProperty({ enum: ProbeProvider, example: ProbeProvider.TENCENT })
    @IsEnum(ProbeProvider)
    provider: ProbeProvider;

    @ApiProperty({ example: 'ap-northeast-1' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    region: string;

    @ApiProperty({ example: 'https://probe.example.com/beaconix/callback' })
    @IsUrl({ require_tld: false })
    @MaxLength(2048)
    callbackUrl: string;

    @ApiPropertyOptional({ example: true, default: true })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;

    @ApiPropertyOptional({ example: 100, default: 0 })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(100000)
    maxTenants?: number;

    @ApiPropertyOptional({ example: 0, default: 0 })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(100000)
    priority?: number;
}
