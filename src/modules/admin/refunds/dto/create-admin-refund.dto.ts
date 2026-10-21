import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsEnum,
    IsInt,
    IsOptional,
    IsString,
    MaxLength,
    Min,
} from 'class-validator';
import { RefundType } from '../../../../generated/prisma/enums';
import { IsCuid } from '../../../../common/decorators/is-cuid.decorator';

/** 后台发起退款。金额只有 `MANUAL` 才需要传。 */
export class CreateAdminRefundDto {
    @ApiProperty({ description: 'Order CUID to refund' })
    @IsCuid()
    orderId: string;

    @ApiPropertyOptional({
        enum: RefundType,
        description:
            'FULL / PRORATED 由政策自动判定（默认）；MANUAL 必须同时给 amount。',
    })
    @IsOptional()
    @IsEnum(RefundType)
    type?: RefundType;

    @ApiPropertyOptional({
        description: 'Manual refund amount in cents (MANUAL only)',
        example: 19933,
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    amount?: number;

    @ApiPropertyOptional({ description: 'Why the refund was granted' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    reason?: string;
}

/** 关闭一条无法继续的退款（被拒、无法原路退回、用户撤回）。 */
export class CloseAdminRefundDto {
    @ApiPropertyOptional({ description: 'Why the refund was closed' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    reason?: string;
}
