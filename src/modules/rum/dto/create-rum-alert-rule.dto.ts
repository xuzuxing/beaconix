import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    ArrayUnique,
    IsArray,
    IsBoolean,
    IsDateString,
    IsEnum,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateIf,
} from 'class-validator';
import { RumAlertMetric, RumAlertScope } from '../../../generated/prisma/enums';

export class CreateRumAlertRuleDto {
    @ApiProperty({ example: 'Frontend errors spike' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name: string;

    @ApiProperty({
        enum: RumAlertMetric,
        description:
            'ERROR_COUNT / EVENT_COUNT compare the window volume against threshold (absolute count). ' +
            'NEW_ERROR fires when a fingerprint is first seen inside the window. ' +
            'ERROR_RATE compares the error/event ratio percentage against threshold; it is not an affected-session error rate. ' +
            'SPIKE compares the window against the previous window; threshold is the growth percentage.',
    })
    @IsEnum(RumAlertMetric)
    metric: RumAlertMetric;

    @ApiPropertyOptional({
        enum: RumAlertScope,
        default: RumAlertScope.APP,
        description:
            'ERROR_GROUP needs groupId and scopes the rule to one error group',
    })
    @IsOptional()
    @IsEnum(RumAlertScope)
    scope?: RumAlertScope;

    @ApiPropertyOptional({ description: 'Required when scope is ERROR_GROUP' })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    groupId?: string;

    @ApiPropertyOptional({ description: 'Required for a specific event count' })
    @IsOptional()
    @IsString()
    @Matches(/^[A-Za-z0-9._:*:-]{1,100}$/)
    eventName?: string;

    @ApiProperty({
        minimum: 1,
        maximum: 1000000,
        description:
            'Absolute count for ERROR_COUNT/EVENT_COUNT/NEW_ERROR, error/event percentage for ERROR_RATE, growth percentage for SPIKE',
    })
    @IsInt()
    @Min(1)
    @Max(1_000_000)
    threshold: number;

    @ApiProperty({ minimum: 1, maximum: 1440, example: 5 })
    @IsInt()
    @Min(1)
    @Max(1440)
    windowMinutes: number;

    @ApiPropertyOptional({
        default: 1,
        maximum: 10,
        description:
            'Consecutive evaluations that must match before opening an incident',
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(10)
    confirmWindows?: number;

    @ApiPropertyOptional({
        nullable: true,
        description:
            'Silence the rule until this instant: incidents are still recorded but no notification is sent',
    })
    @IsOptional()
    @ValidateIf((value: CreateRumAlertRuleDto) => value.silenceUntil !== null)
    @IsDateString()
    silenceUntil?: string | null;

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
