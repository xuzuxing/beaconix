import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsDateString,
    IsEnum,
    IsInt,
    IsOptional,
    IsString,
    Max,
    Min,
} from 'class-validator';
import {
    PaymentChannel,
    RefundStatus,
} from '../../../../generated/prisma/enums';
import { IsCuid } from '../../../../common/decorators/is-cuid.decorator';

/**
 * 跨租户退款查询。所有过滤条件都是可选的；不传则返回全平台最新的退款记录。
 */
export class QueryAdminRefundsDto {
    @ApiPropertyOptional({ description: 'Filter by organization ID' })
    @IsOptional()
    @IsCuid()
    organizationId?: string;

    @ApiPropertyOptional({ description: 'Filter by order ID' })
    @IsOptional()
    @IsCuid()
    orderId?: string;

    @ApiPropertyOptional({
        enum: PaymentChannel,
        description: 'Filter by payment channel',
    })
    @IsOptional()
    @IsEnum(PaymentChannel)
    channel?: PaymentChannel;

    @ApiPropertyOptional({
        enum: RefundStatus,
        description: 'Filter by refund status',
    })
    @IsOptional()
    @IsEnum(RefundStatus)
    status?: RefundStatus;

    @ApiPropertyOptional({ description: 'Exact refund number' })
    @IsOptional()
    @IsString()
    refundNo?: string;

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
