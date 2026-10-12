import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsDateString,
    IsEnum,
    IsInt,
    IsOptional,
    IsString,
    Max,
    Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderStatus } from '../../../../generated/prisma/enums';
import { IsCuid } from '../../../../common/decorators/is-cuid.decorator';

/**
 * Cross-tenant order query for SUPER_ADMIN. Every filter is opt-in; with no
 * filter at all it returns the newest orders across the whole platform.
 */
export class QueryAdminOrdersDto {
    @ApiPropertyOptional({ description: 'Filter by organization ID' })
    @IsOptional()
    @IsCuid()
    organizationId?: string;

    @ApiPropertyOptional({ description: 'Filter by buyer (user) ID' })
    @IsOptional()
    @IsCuid()
    userId?: string;

    @ApiPropertyOptional({ description: 'Filter by plan ID' })
    @IsOptional()
    @IsCuid()
    planId?: string;

    @ApiPropertyOptional({
        enum: OrderStatus,
        description: 'Filter by order status',
    })
    @IsOptional()
    @IsEnum(OrderStatus)
    status?: OrderStatus;

    @ApiPropertyOptional({ description: 'Exact order number' })
    @IsOptional()
    @IsString()
    orderNo?: string;

    @ApiPropertyOptional({
        description: 'Start date (ISO 8601)',
        example: '2026-01-01T00:00:00.000Z',
    })
    @IsOptional()
    @IsDateString()
    from?: string;

    @ApiPropertyOptional({
        description: 'End date (ISO 8601)',
        example: '2026-12-31T23:59:59.999Z',
    })
    @IsOptional()
    @IsDateString()
    to?: string;

    @ApiPropertyOptional({ default: 1, minimum: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number = 1;

    @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    limit?: number = 25;
}
