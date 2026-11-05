import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsDateString,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
} from 'class-validator';
import { RumErrorStatus } from '../../../generated/prisma/enums';

export const RUM_ERROR_STATUS_FILTERS = [
    'ALL',
    RumErrorStatus.UNRESOLVED,
    RumErrorStatus.RESOLVED,
    RumErrorStatus.IGNORED,
] as const;

export type RumErrorStatusFilter = (typeof RUM_ERROR_STATUS_FILTERS)[number];

export class QueryRumErrorsDto {
    @ApiPropertyOptional({ default: 1, minimum: 1 })
    @IsOptional()
    @IsInt()
    @Min(1)
    page: number = 1;

    @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(100)
    limit: number = 20;

    @ApiPropertyOptional({ example: 'unhandledrejection' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    type?: string;

    @ApiPropertyOptional({
        enum: RUM_ERROR_STATUS_FILTERS,
        default: RumErrorStatus.UNRESOLVED,
        description:
            'Filter by lifecycle status. ALL returns every group; the default keeps the pre-existing "what needs work" view.',
    })
    @IsOptional()
    @IsIn(RUM_ERROR_STATUS_FILTERS)
    status: RumErrorStatusFilter = RumErrorStatus.UNRESOLVED;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(100)
    release?: string;

    @ApiPropertyOptional({ example: 'profile' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    search?: string;

    @ApiPropertyOptional({ example: '2026-11-01T00:00:00.000Z' })
    @IsOptional()
    @IsDateString()
    from?: string;

    @ApiPropertyOptional({ example: '2026-11-03T23:59:59.999Z' })
    @IsOptional()
    @IsDateString()
    to?: string;

    @ApiPropertyOptional({
        enum: ['lastSeenAt', 'firstSeenAt', 'count'],
        default: 'lastSeenAt',
    })
    @IsOptional()
    @IsIn(['lastSeenAt', 'firstSeenAt', 'count'])
    sortBy: 'lastSeenAt' | 'firstSeenAt' | 'count' = 'lastSeenAt';

    @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
    @IsOptional()
    @IsIn(['asc', 'desc'])
    sortOrder: 'asc' | 'desc' = 'desc';
}
