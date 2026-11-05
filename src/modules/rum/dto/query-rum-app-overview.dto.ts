import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, Max, Min } from 'class-validator';

/** 时间窗查询：应用概览与错误概览共用同一套窗口与分桶参数。 */
export class QueryRumWindowDto {
    @ApiPropertyOptional({
        example: '2026-11-01T00:00:00.000Z',
        description: 'Window start. Defaults to 24 hours before `to`.',
    })
    @IsOptional()
    @IsDateString()
    from?: string;

    @ApiPropertyOptional({
        example: '2026-11-02T00:00:00.000Z',
        description:
            'Window end. Defaults to now. The window may span 90 days.',
    })
    @IsOptional()
    @IsDateString()
    to?: string;

    @ApiPropertyOptional({
        minimum: 5,
        maximum: 1440,
        description:
            'Series bucket size in minutes. Defaults to a size derived from the window.',
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(5)
    @Max(1440)
    bucketMinutes?: number;
}

export class QueryRumAppOverviewDto extends QueryRumWindowDto {}
