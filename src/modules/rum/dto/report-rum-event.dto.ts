import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsDateString,
    IsObject,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    MinLength,
} from 'class-validator';

export class ReportRumEventDto {
    @ApiProperty()
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    publicKey: string;

    @ApiProperty({ example: 'checkout_completed' })
    @IsString()
    @Matches(/^[A-Za-z0-9._:-]{1,100}$/)
    eventName: string;

    @ApiPropertyOptional({ description: 'Application-defined end-user ID' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    userId?: string;

    @ApiPropertyOptional({ description: 'Anonymous browser/device ID' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    anonymousId?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(100)
    sessionId?: string;

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

    @ApiPropertyOptional({ type: Object })
    @IsOptional()
    @IsObject()
    properties?: Record<string, unknown>;

    @ApiPropertyOptional()
    @IsOptional()
    @IsDateString()
    occurredAt?: string;
}
