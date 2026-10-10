import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsInt,
    IsISO8601,
    IsOptional,
    IsString,
    IsBoolean,
    ValidateNested,
    Max,
    MaxLength,
    Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ProbeResultItemDto {
    @ApiPropertyOptional({
        description: 'Assigned monitor identity; required by current agents',
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    monitorId?: string;

    @ApiPropertyOptional({
        description: 'Stable observation identity, reused on retries',
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    reportId?: string;

    @ApiPropertyOptional({
        description: 'Configuration revision supplied by heartbeat',
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    configRevision?: number;
    @ApiProperty({
        example: 'https://api.example.com/health',
        description: 'Must match the target of a monitor in the organization',
    })
    @IsString()
    @MaxLength(2048)
    target: string;

    @ApiProperty({ example: true })
    @IsBoolean()
    success: boolean;

    @ApiProperty({ example: 128, description: 'Round-trip time in ms' })
    @IsInt()
    @Min(0)
    @Max(600000)
    latency: number;

    @ApiPropertyOptional({ example: 'connect ECONNREFUSED' })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    error?: string;

    @ApiPropertyOptional({
        example: 200,
        description: 'Actual HTTP status code observed by the probe (optional)',
    })
    @IsOptional()
    @IsInt()
    @Min(100)
    @Max(599)
    statusCode?: number;

    @ApiPropertyOptional({
        example: '2026-03-05T12:00:00.000Z',
        description: 'Defaults to the time the report is received',
    })
    @IsOptional()
    @IsISO8601()
    checkedAt?: string;
}

export class ReportProbeResultsDto {
    @ApiProperty({ type: [ProbeResultItemDto] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(100)
    @ValidateNested({ each: true })
    @Type(() => ProbeResultItemDto)
    results: ProbeResultItemDto[];
}
