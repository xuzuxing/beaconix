import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsDateString,
    IsOptional,
    IsString,
    MaxLength,
    MinLength,
} from 'class-validator';

export class ReportRumErrorDto {
    @ApiProperty({ example: 'rum_m7m1RrVb3hO9YkQe8Jp2p1sA' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    publicKey: string;

    @ApiProperty({ example: 'unhandledrejection' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    type: string;

    @ApiProperty({ example: 'Failed to load customer profile' })
    @IsString()
    @MinLength(1)
    @MaxLength(2000)
    message: string;

    @ApiPropertyOptional({ example: 'Error: Failed\n    at loadProfile (...)' })
    @IsOptional()
    @IsString()
    @MaxLength(16000)
    stack?: string;

    @ApiPropertyOptional({ example: 'https://app.example.com/dashboard' })
    @IsOptional()
    @IsString()
    @MaxLength(2048)
    page?: string;

    @ApiPropertyOptional({ example: 'web-2026.11.03.1' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    release?: string;

    @ApiPropertyOptional({ description: 'Related replay session ID' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    sessionId?: string;

    @ApiPropertyOptional({ example: '2026-11-03T08:00:00.000Z' })
    @IsOptional()
    @IsDateString()
    occurredAt?: string;
}
