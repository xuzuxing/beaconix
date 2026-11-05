import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsDateString,
    IsInt,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
} from 'class-validator';

export class QueryRumPerformanceDto {
    @ApiPropertyOptional({
        example: 'LCP,INP,CLS,FCP,TTFB',
        description: 'Comma separated performance metrics',
    })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    metrics?: string;

    @ApiPropertyOptional({ example: '2026-11-01T00:00:00.000Z' })
    @IsOptional()
    @IsDateString()
    from?: string;

    @ApiPropertyOptional({ example: '2026-11-04T00:00:00.000Z' })
    @IsOptional()
    @IsDateString()
    to?: string;

    @ApiPropertyOptional({ example: '/dashboard' })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    page?: string;

    @ApiPropertyOptional({
        description: 'Empty value selects reports without a release tag',
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    release?: string;
}

export class QueryRumPerformancePagesDto {
    @ApiPropertyOptional({ example: '2026-11-01T00:00:00.000Z' })
    @IsOptional()
    @IsDateString()
    from?: string;

    @ApiPropertyOptional({ example: '2026-11-04T00:00:00.000Z' })
    @IsOptional()
    @IsDateString()
    to?: string;

    @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(100)
    limit: number = 20;
}

export class QueryRumPerformanceResourcesDto {
    @ApiPropertyOptional({ example: '2026-11-01T00:00:00.000Z' })
    @IsOptional()
    @IsDateString()
    from?: string;

    @ApiPropertyOptional({ example: '2026-11-04T00:00:00.000Z' })
    @IsOptional()
    @IsDateString()
    to?: string;

    @ApiPropertyOptional({ enum: ['RESOURCE', 'HTTP'], default: 'RESOURCE' })
    @IsOptional()
    @IsString()
    metric: string = 'RESOURCE';

    @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(100)
    limit: number = 20;
}
