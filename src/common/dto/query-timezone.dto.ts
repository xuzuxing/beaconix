import { BadRequestException } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString } from 'class-validator';

/**
 * Shared `tz` query parameter for endpoints that bucket samples by local time.
 *
 * The value is resolved through `Intl` so aliases collapse to their canonical
 * IANA name, and fixed offsets (`+08:00`) are rejected: a named zone is what
 * makes day and hour buckets follow the visitor's real calendar, including DST.
 */
export class QueryTimezoneDto {
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
