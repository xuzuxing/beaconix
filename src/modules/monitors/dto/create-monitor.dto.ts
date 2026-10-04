import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

export class CreateMonitorDto {
    @ApiProperty({ example: 'Production API', description: 'Monitor name' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name: string;

    @ApiProperty({
        enum: MonitorType,
        example: MonitorType.HTTP,
        description: 'Check protocol',
    })
    @IsEnum(MonitorType)
    type: MonitorType;

    @ApiProperty({
        example: 'https://api.example.com/health',
        description: 'URL (HTTP) or host:port (TCP) to check',
    })
    @IsString()
    @MinLength(1)
    @MaxLength(2048)
    target: string;

    @ApiPropertyOptional({
        example: 60,
        description: 'Seconds between checks',
        default: 60,
    })
    @IsOptional()
    @IsInt()
    @Min(10)
    @Max(86400)
    interval?: number;

    @ApiPropertyOptional({
        example: 5000,
        description: 'Request timeout in milliseconds',
        default: 5000,
    })
    @IsOptional()
    @IsInt()
    @Min(100)
    @Max(60000)
    timeout?: number;

    @ApiPropertyOptional({
        example: 200,
        description: 'Expected HTTP status code (HTTP monitors only)',
        default: 200,
    })
    @IsOptional()
    @IsInt()
    @Min(100)
    @Max(599)
    expectedStatus?: number;

    @ApiPropertyOptional({
        example: 3,
        description: 'Consecutive failures before the monitor is marked DOWN',
        default: 3,
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(10)
    failureThreshold?: number;

    @ApiPropertyOptional({
        example: true,
        description: 'Whether checks are scheduled for this monitor',
        default: true,
    })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;
}
