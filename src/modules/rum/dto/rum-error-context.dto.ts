import { Type } from 'class-transformer';
import {
    IsDateString,
    IsIn,
    IsInt,
    IsObject,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
    ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const RUM_ERROR_CATEGORIES = [
    'JAVASCRIPT',
    'PROMISE',
    'RESOURCE',
    'HTTP',
    'VUE',
    'MANUAL',
] as const;

export const RUM_ERROR_LEVELS = ['INFO', 'WARNING', 'ERROR', 'FATAL'] as const;

export type RumErrorCategoryValue = (typeof RUM_ERROR_CATEGORIES)[number];
export type RumErrorLevelValue = (typeof RUM_ERROR_LEVELS)[number];

export class RumBreadcrumbDto {
    @ApiProperty({ example: 'http' })
    @IsString()
    @MaxLength(50)
    type: string;

    @ApiPropertyOptional({ example: 'request' })
    @IsOptional()
    @IsString()
    @MaxLength(50)
    category?: string;

    @ApiPropertyOptional({ enum: RUM_ERROR_LEVELS })
    @IsOptional()
    @IsIn(RUM_ERROR_LEVELS)
    level?: RumErrorLevelValue;

    @ApiProperty({ example: '2026-11-04T08:00:00.000Z' })
    @IsDateString()
    occurredAt: string;

    @ApiPropertyOptional({ type: Object })
    @IsOptional()
    @IsObject()
    data?: Record<string, unknown>;
}

export class RumHttpContextDto {
    @ApiPropertyOptional({ example: 'GET' })
    @IsOptional()
    @IsString()
    @Matches(/^[A-Za-z]{1,20}$/)
    method?: string;

    @ApiPropertyOptional({ example: 'https://api.example.com/profile' })
    @IsOptional()
    @IsString()
    @MaxLength(2048)
    url?: string;

    @ApiPropertyOptional({ example: 500 })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(999)
    status?: number;

    @ApiPropertyOptional({ example: 315 })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(86_400_000)
    durationMs?: number;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(200)
    requestId?: string;

    @ApiPropertyOptional({ example: 'server' })
    @IsOptional()
    @IsString()
    @MaxLength(50)
    failureKind?: string;
}

export class RumResourceContextDto {
    @ApiPropertyOptional({ example: 'script' })
    @IsOptional()
    @IsString()
    @MaxLength(50)
    tagName?: string;

    @ApiPropertyOptional({ example: 'https://cdn.example.com/assets/app.js' })
    @IsOptional()
    @IsString()
    @MaxLength(2048)
    url?: string;
}

export class RumVueContextDto {
    @ApiPropertyOptional({ example: 'UserProfile' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    componentName?: string;

    @ApiPropertyOptional({ example: 'render function' })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    info?: string;
}

export class RumSdkContextDto {
    @ApiPropertyOptional({ example: '@beaconix/rum-browser' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    name?: string;

    @ApiPropertyOptional({ example: '0.2.0' })
    @IsOptional()
    @IsString()
    @MaxLength(50)
    version?: string;
}

export class RumErrorContextDto {
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
}
