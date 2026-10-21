import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional } from 'class-validator';
import { PaymentChannel } from '../../../../generated/prisma/enums';
import { IsCuid } from '../../../../common/decorators/is-cuid.decorator';

/** 退款对账的过滤条件：只按租户/渠道/时间筛选，不做分页。 */
export class QueryAdminRefundStatsDto {
    @ApiPropertyOptional({ description: 'Filter by organization ID' })
    @IsOptional()
    @IsCuid()
    organizationId?: string;

    @ApiPropertyOptional({
        enum: PaymentChannel,
        description: 'Filter by payment channel',
    })
    @IsOptional()
    @IsEnum(PaymentChannel)
    channel?: PaymentChannel;

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
}
