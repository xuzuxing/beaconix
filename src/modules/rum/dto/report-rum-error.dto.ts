import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    IsArray,
    IsDateString,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
    RUM_ERROR_CATEGORIES,
    RUM_ERROR_LEVELS,
    RumBreadcrumbDto,
    RumHttpContextDto,
    RumResourceContextDto,
    RumSdkContextDto,
    RumVueContextDto,
} from './rum-error-context.dto';
import type {
    RumErrorCategoryValue,
    RumErrorLevelValue,
} from './rum-error-context.dto';

export class ReportRumErrorDto {
    @ApiPropertyOptional({ enum: [2], example: 2 })
    @IsOptional()
    @IsInt()
    @Min(2)
    @Max(2)
    schemaVersion?: number;

    @ApiPropertyOptional({ example: 'dc5ab2f7-42cc-4578-a2aa-71168e20b559' })
    @IsOptional()
    @IsString()
    @Matches(/^[A-Za-z0-9_-]{8,100}$/)
    clientEventId?: string;

    @ApiProperty({ example: 'rum_m7m1RrVb3hO9YkQe8Jp2p1sA' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    publicKey: string;

    @ApiProperty({ example: 'unhandledrejection' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    type: string;

    @ApiPropertyOptional({ enum: RUM_ERROR_CATEGORIES })
    @IsOptional()
    @IsIn(RUM_ERROR_CATEGORIES)
    category?: RumErrorCategoryValue;

    @ApiPropertyOptional({ enum: RUM_ERROR_LEVELS })
    @IsOptional()
    @IsIn(RUM_ERROR_LEVELS)
    level?: RumErrorLevelValue;

    @ApiProperty({ example: 'Failed to load customer profile' })
    @IsString()
    @MinLength(1)
    @MaxLength(2000)
    message: string;

    @ApiPropertyOptional({ example: 'Error: Failed\n    at loadProfile (...)' })
    @IsOptional()
    @IsString()
    @MaxLength(16000)
    stack?: string;

    @ApiPropertyOptional({ example: 'https://app.example.com/dashboard' })
    @IsOptional()
    @IsString()
    @MaxLength(2048)
    page?: string;

    @ApiPropertyOptional({ example: 'web-2026.11.03.1' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    release?: string;

    @ApiPropertyOptional({ description: 'Related replay session ID' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    sessionId?: string;

    @ApiPropertyOptional({ description: 'Application-defined end-user ID' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    userId?: string;

    @ApiPropertyOptional({ description: 'Anonymous browser/device ID' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    anonymousId?: string;

    @ApiPropertyOptional({ description: 'Related server request ID' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    requestId?: string;

    @ApiPropertyOptional({ type: RumHttpContextDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => RumHttpContextDto)
    http?: RumHttpContextDto;

    @ApiPropertyOptional({ type: RumResourceContextDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => RumResourceContextDto)
    resource?: RumResourceContextDto;

    @ApiPropertyOptional({ type: RumVueContextDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => RumVueContextDto)
    vue?: RumVueContextDto;

    @ApiPropertyOptional({ type: [RumBreadcrumbDto], maxItems: 50 })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @ValidateNested({ each: true })
    @Type(() => RumBreadcrumbDto)
    breadcrumbs?: RumBreadcrumbDto[];

    @ApiPropertyOptional({ type: RumSdkContextDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => RumSdkContextDto)
    sdk?: RumSdkContextDto;

    @ApiPropertyOptional({ example: '2026-11-03T08:00:00.000Z' })
    @IsOptional()
    @IsDateString()
    occurredAt?: string;
}
