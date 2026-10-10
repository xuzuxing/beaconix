import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { BadRequestException } from '@nestjs/common';
import type { MonitoringRange } from '../monitoring-window.util';

const integer = ({
    obj,
    key,
}: {
    obj: Record<string, unknown>;
    key: string;
}) =>
    typeof obj[key] === 'string' && /^\d+$/.test(obj[key])
        ? Number(obj[key])
        : NaN;

export class MonitoringTimezoneDto {
    @ApiPropertyOptional({
        default: 'Asia/Shanghai',
        description: 'IANA time zone',
    })
    @IsString()
    @Transform(({ value }: { value: unknown }) => {
        if (typeof value !== 'string' || !value || /^[+-]/.test(value)) {
            throw new BadRequestException('tz must be an IANA time zone');
        }
        try {
            return new Intl.DateTimeFormat('en', {
                timeZone: value,
            }).resolvedOptions().timeZone;
        } catch {
            throw new BadRequestException('Invalid IANA time zone');
        }
    })
    tz = 'Asia/Shanghai';
}

export class QueryMonitoringDashboardDto extends MonitoringTimezoneDto {
    @ApiPropertyOptional({ enum: ['1h', 'today', '7d', '30d'], default: '1h' })
    @IsIn(['1h', 'today', '7d', '30d'])
    range: MonitoringRange = '1h';
    @ApiPropertyOptional({ default: 6, minimum: 1, maximum: 20 })
    @Transform(integer)
    @IsInt()
    @Min(1)
    @Max(20)
    slowLimit = 6;
    @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 })
    @Transform(integer)
    @IsInt()
    @Min(1)
    @Max(50)
    alertLimit = 10;
}

export class QueryMonitoringAvailabilityDto extends MonitoringTimezoneDto {
    @ApiPropertyOptional({ default: 30, minimum: 1, maximum: 30 })
    @Transform(integer)
    @IsInt()
    @Min(1)
    @Max(30)
    days = 30;
}

export class QueryMonitoringStatusCodesDto extends MonitoringTimezoneDto {
    @ApiPropertyOptional({ default: 12, minimum: 1, maximum: 48 })
    @Transform(integer)
    @IsInt()
    @Min(1)
    @Max(48)
    hours = 12;
}
