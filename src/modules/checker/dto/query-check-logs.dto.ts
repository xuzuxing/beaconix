import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsBoolean,
    IsEnum,
    IsInt,
    IsOptional,
    IsString,
    Max,
    Min,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { CheckSource } from '../../../generated/prisma/enums';

export class QueryCheckLogsDto {
    @ApiPropertyOptional({
        description: 'Filter by check result',
        example: false,
    })
    @IsOptional()
    @Transform(({ value }) =>
        value === 'true' || value === true
            ? true
            : value === 'false' || value === false
              ? false
              : value,
    )
    @IsBoolean()
    success?: boolean;

    @ApiPropertyOptional({
        enum: CheckSource,
        description: 'Filter by where the check ran',
        example: CheckSource.LOCAL,
    })
    @IsOptional()
    @IsEnum(CheckSource)
    source?: CheckSource;

    @ApiPropertyOptional({
        description:
            'Filter by batch (round) id - the aggregation window one local check anchored',
        example: 'cmgu92m5x0005p8l4h8z6s3k6:1709620800000',
    })
    @IsOptional()
    @IsString()
    roundId?: string;

    @ApiPropertyOptional({ default: 1, minimum: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number;

    @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    limit?: number;
}
