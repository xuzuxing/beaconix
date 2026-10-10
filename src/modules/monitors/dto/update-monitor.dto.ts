import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsArray,
    IsBoolean,
    IsEnum,
    IsInt,
    IsNumber,
    IsOptional,
    IsObject,
    ValidateIf,
    IsString,
    Max,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';
import { MonitorType } from '../../../generated/prisma/enums';
import { MONITOR_CONFIG_API_OPTIONS } from './monitor-config.schema';

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

    @ApiPropertyOptional({
        ...MONITOR_CONFIG_API_OPTIONS,
        description: `Replaces the entire config; required on type changes. ${MONITOR_CONFIG_API_OPTIONS.description}`,
    })
    @ValidateIf((_, value: unknown) => value !== undefined)
    @IsObject()
    config?: Record<string, unknown>;

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

    @ApiPropertyOptional({
        example: true,
        description: 'Whether HTTPS certificate expiry should be monitored',
    })
    @IsOptional()
    @IsBoolean()
    checkSsl?: boolean;

    @ApiPropertyOptional({
        example: 30,
        description: 'Days before SSL certificate expiry that should alert',
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(365)
    sslExpiryThreshold?: number;

    @ApiPropertyOptional({ example: false })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;

    @ApiPropertyOptional({
        example: true,
        description: 'Enable availability-based alerting for this monitor',
    })
    @IsOptional()
    @IsBoolean()
    availabilityEnabled?: boolean;

    @ApiPropertyOptional({
        example: 90,
        description: 'Availability threshold in percent',
    })
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Max(100)
    availabilityThreshold?: number;

    @ApiPropertyOptional({
        example: 10,
        description:
            'Number of most recent checks used to compute availability',
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(1000)
    availabilityWindow?: number;

    @ApiPropertyOptional({
        example: ['clx123channel1'],
        description:
            'Notification channel IDs bound to this monitor (multi-select); empty array clears bindings',
        type: [String],
    })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    notificationChannelIds?: string[];
}
