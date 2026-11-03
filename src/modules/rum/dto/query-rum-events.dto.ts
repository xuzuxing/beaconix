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

export class QueryRumEventsDto {
    @ApiPropertyOptional({ default: 1 })
    @IsOptional()
    @IsInt()
    @Min(1)
    page = 1;

    @ApiPropertyOptional({ default: 20, maximum: 100 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(100)
    limit = 20;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(100)
    eventName?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(100)
    sessionId?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsDateString()
    from?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsDateString()
    to?: string;
}

export class QueryRumEventStatsDto {
    @ApiPropertyOptional({ default: 7, minimum: 1, maximum: 90 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(90)
    days = 7;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(100)
    eventName?: string;
}
