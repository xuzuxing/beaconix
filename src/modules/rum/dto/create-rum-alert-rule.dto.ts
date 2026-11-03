import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    ArrayUnique,
    IsArray,
    IsBoolean,
    IsEnum,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';
import { RumAlertMetric } from '../../../generated/prisma/enums';

export class CreateRumAlertRuleDto {
    @ApiProperty({ example: 'Frontend errors spike' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name: string;

    @ApiProperty({ enum: RumAlertMetric })
    @IsEnum(RumAlertMetric)
    metric: RumAlertMetric;

    @ApiPropertyOptional({ description: 'Required for a specific event count' })
    @IsOptional()
    @IsString()
    @Matches(/^[A-Za-z0-9._:*:-]{1,100}$/)
    eventName?: string;

    @ApiProperty({ minimum: 1, maximum: 1000000 })
    @IsInt()
    @Min(1)
    @Max(1_000_000)
    threshold: number;

    @ApiProperty({ minimum: 1, maximum: 1440, example: 5 })
    @IsInt()
    @Min(1)
    @Max(1440)
    windowMinutes: number;

    @ApiPropertyOptional({ type: [String] })
    @IsOptional()
    @IsArray()
    @ArrayUnique()
    @ArrayMaxSize(20)
    @IsString({ each: true })
    channelIds?: string[];

    @ApiPropertyOptional({ default: true })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;
}
