import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsInt,
    IsISO8601,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ProbeResultItemDto {
    @ApiProperty({
        example: 'https://api.example.com/health',
        description: 'Must match the target of a monitor in the organization',
    })
    @IsString()
    @MaxLength(2048)
    target: string;

    @ApiProperty({ example: true })
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
    @Type(() => ProbeResultItemDto)
    results: ProbeResultItemDto[];
}
