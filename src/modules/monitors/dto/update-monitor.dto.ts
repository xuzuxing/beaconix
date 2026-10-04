import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsBoolean,
    IsEnum,
    IsInt,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';
import { MonitorType } from '../../../generated/prisma/enums';

export class UpdateMonitorDto {
    @ApiPropertyOptional({ example: 'Production API v2' })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name?: string;

    @ApiPropertyOptional({ enum: MonitorType, example: MonitorType.HTTP })
    @IsOptional()
    @IsEnum(MonitorType)
    type?: MonitorType;

    @ApiPropertyOptional({ example: 'https://api.example.com/healthz' })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(2048)
    target?: string;

    @ApiPropertyOptional({ example: 30, description: 'Seconds between checks' })
    @IsOptional()
    @IsInt()
    @Min(10)
    @Max(86400)
    interval?: number;

    @ApiPropertyOptional({
        example: 3000,
        description: 'Request timeout in milliseconds',
    })
    @IsOptional()
    @IsInt()
    @Min(100)
    @Max(60000)
    timeout?: number;

    @ApiPropertyOptional({
        example: 204,
        description: 'Expected HTTP status code (HTTP monitors only)',
    })
    @IsOptional()
    @IsInt()
    @Min(100)
    @Max(599)
    expectedStatus?: number;

    @ApiPropertyOptional({
        example: 5,
        description: 'Consecutive failures before the monitor is marked DOWN',
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(10)
    failureThreshold?: number;

    @ApiPropertyOptional({ example: false })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;
}
