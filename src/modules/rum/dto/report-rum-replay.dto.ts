import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsDateString,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';

export class ReportRumReplayDto {
    @ApiProperty()
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    publicKey: string;

    @ApiProperty()
    @IsString()
    @Matches(/^[A-Za-z0-9_-]{8,100}$/)
    sessionId: string;

    @ApiProperty({ minimum: 0 })
    @IsInt()
    @Min(0)
    sequence: number;

    @ApiProperty({ type: [Object] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(200)
    events: unknown[];

    @ApiProperty()
    @IsDateString()
    startedAt: string;

    @ApiProperty()
    @IsDateString()
    occurredAt: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(100)
    release?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(2048)
    page?: string;
}
