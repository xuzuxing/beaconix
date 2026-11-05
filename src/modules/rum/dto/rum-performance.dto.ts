import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsDateString,
    IsIn,
    IsInt,
    IsNumber,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateNested,
} from 'class-validator';

export const RUM_PERF_METRICS = [
    'LCP',
    'CLS',
    'INP',
    'FCP',
    'TTFB',
    'PAGE_LOAD',
    'RESOURCE',
    'HTTP',
] as const;

export const RUM_PERF_RATINGS = ['GOOD', 'NEEDS_IMPROVEMENT', 'POOR'] as const;

export type RumPerfMetricValue = (typeof RUM_PERF_METRICS)[number];
export type RumPerfRatingValue = (typeof RUM_PERF_RATINGS)[number];

export class RumPerformanceSampleDto {
    @ApiProperty({ enum: RUM_PERF_METRICS })
    @IsIn(RUM_PERF_METRICS)
    metric: RumPerfMetricValue;

    @ApiProperty({
        example: 2312.4,
        description:
            'Milliseconds for timing metrics, unitless score for CLS, a 0-1 ratio for success is not used here',
    })
    @IsNumber()
    @Min(0)
    @Max(600_000)
    value: number;

    @ApiPropertyOptional({ enum: RUM_PERF_RATINGS })
    @IsOptional()
    @IsIn(RUM_PERF_RATINGS)
    rating?: RumPerfRatingValue;

    @ApiPropertyOptional({ example: '/dashboard' })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    page?: string;

    @ApiPropertyOptional({ example: '2.4.0' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    release?: string;

    @ApiPropertyOptional({
        example: 'https://cdn.example.com/app.js',
        description: 'Resource URL for RESOURCE, request path for HTTP',
    })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    dimension?: string;

    @ApiPropertyOptional({ default: true })
    @IsOptional()
    @IsBoolean()
    success?: boolean;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @Matches(/^[A-Za-z0-9_-]{1,100}$/)
    sessionId?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(200)
    endUserId?: string;

    @ApiPropertyOptional({ example: '2026-11-04T10:00:00.000Z' })
    @IsOptional()
    @IsDateString()
    occurredAt?: string;
}

export class ReportRumPerformanceDto {
    @ApiProperty({ example: 'rum_m7m1RrVb3hO9YkQe8Jp2p1sA' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    publicKey: string;

    @ApiProperty({ type: [RumPerformanceSampleDto] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(50)
    @ValidateNested({ each: true })
    @Type(() => RumPerformanceSampleDto)
    samples: RumPerformanceSampleDto[];

    @ApiPropertyOptional({ enum: [1], example: 1 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(2)
    schemaVersion?: number;
}
