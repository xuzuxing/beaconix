import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsInt,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';

export class CreateRumErrorNoteDto {
    @ApiProperty({ example: 'Fixed in 2.4.1, verifying on staging.' })
    @IsString()
    @MinLength(1)
    @MaxLength(2000)
    body: string;
}

export class QueryRumErrorNotesDto {
    @ApiPropertyOptional({ default: 1, minimum: 1 })
    @IsOptional()
    @IsInt()
    @Min(1)
    page: number = 1;

    @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(100)
    limit: number = 20;
}
