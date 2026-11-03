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

export class QueryRumReplaysDto {
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
    release?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsDateString()
    from?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsDateString()
    to?: string;
}

export class QueryRumReplayChunksDto {
    @ApiPropertyOptional({ default: -1 })
    @IsOptional()
    @IsInt()
    @Min(-1)
    afterSequence = -1;

    @ApiPropertyOptional({ default: 50, maximum: 100 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(100)
    limit = 50;
}
