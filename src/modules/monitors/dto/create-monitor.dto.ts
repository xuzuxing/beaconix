import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
        description:
            'HTTP/WS URL; TCP/database/gRPC host:port; DNS domain; PING hostname/IP; Docker HTTPS origin or unix:///var/run/docker.sock. No credentials in application targets.',
    })
    @IsString()
    @MinLength(1)
    @MaxLength(2048)
    target: string;

    @ApiPropertyOptional({
        ...MONITOR_CONFIG_API_OPTIONS,
        example: { recordType: 'A', expectedValues: ['1.1.1.1'] },
    })
    @ValidateIf((_, value: unknown) => value !== undefined)
    @IsObject()
    config?: Record<string, unknown>;

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
        example: 100,
        minimum: 1,
        maximum: 100,
        default: 1,
        description:
            'Minimum success percentage of the currently bound tenant probes; the probe verdict overrides a local success and rescues a local failure',
    })
    @ValidateIf((_, value: unknown) => value !== undefined)
    @IsInt()
    @Min(1)
    @Max(100)
    probeSuccessRatio?: number;

    @ApiPropertyOptional({
        example: true,
        description: 'Whether HTTPS certificate expiry should be monitored',
        default: false,
    })
    @IsOptional()
    @IsBoolean()
    checkSsl?: boolean;

    @ApiPropertyOptional({
        example: 30,
        description: 'Days before SSL certificate expiry that should alert',
        default: 30,
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(365)
    sslExpiryThreshold?: number;

    @ApiPropertyOptional({
        example: true,
        description: 'Whether checks are scheduled for this monitor',
        default: true,
    })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;

    @ApiPropertyOptional({
        example: true,
        description: 'Enable availability-based alerting for this monitor',
        default: false,
    })
    @IsOptional()
    @IsBoolean()
    availabilityEnabled?: boolean;

    @ApiPropertyOptional({
        example: 90,
        description:
            'Availability threshold in percent; alerts when recent availability is below it',
        default: 90,
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
        default: 10,
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(1000)
    availabilityWindow?: number;

    @ApiPropertyOptional({
        example: ['clx123channel1'],
        description:
            'Notification channel IDs bound to this monitor (multi-select)',
        type: [String],
    })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    notificationChannelIds?: string[];

    @ApiPropertyOptional({
        example: ['clx123probe1'],
        description:
            'Tenant probes to assign at creation time; capped by the plan per-monitor probe limit',
        type: [String],
    })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    probeIds?: string[];
}
