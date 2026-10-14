import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

export class CreateProbeDto {
    @ApiProperty({ example: 'Tokyo probe' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name: string;

    @ApiProperty({
        enum: ProbeProvider,
        example: ProbeProvider.TENCENT,
        description: 'Where the probe is hosted',
    })
    @IsEnum(ProbeProvider)
    provider: ProbeProvider;

    @ApiProperty({ example: 'ap-northeast-1' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    region: string;

    @ApiProperty({
        example: 'https://probe.example.com/beaconix/callback',
        description: 'URL the platform may call back for control messages',
    })
    @IsUrl({ require_tld: false })
    @MaxLength(2048)
    callbackUrl: string;

    @ApiPropertyOptional({
        example: true,
        description: 'Whether the probe may report results',
        default: true,
    })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;
}
