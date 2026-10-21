import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** 后台退款列表项：退款记录 + 订单号扁平化，表格不需要再做关联查询。 */
export class AdminRefundEntity {
    @ApiProperty({ example: 'uuid-refund' })
    id: string;

    @ApiProperty({ example: 'RFMB3KXABC123' })
    refundNo: string;

    @ApiProperty({ example: 'uuid-order' })
    orderId: string;

    @ApiProperty({ example: 'BWMB3KXABC123' })
    orderNo: string;

    @ApiProperty({ example: 'uuid-org' })
    organizationId: string;

    @ApiProperty({ enum: ['WECHAT', 'WECHAT_VIRTUAL', 'ALIPAY'] })
    channel: string;

    @ApiProperty({ enum: ['FULL', 'PRORATED', 'MANUAL'] })
    type: string;

    @ApiProperty({
        enum: ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CLOSED'],
    })
    status: string;

    @ApiProperty({ example: 19933, description: 'Requested amount in cents' })
    amount: number;

    @ApiPropertyOptional({
        example: 19933,
        description: 'Amount actually refunded by the channel, in cents',
    })
    settledAmount: number | null;

    @ApiPropertyOptional({
        example: 'PRORATED',
        description: 'COOLING_OFF / NOT_STARTED / PRORATED / MANUAL',
    })
    policyCode: string | null;

    @ApiPropertyOptional({ example: 10 })
    usedDays: number | null;

    @ApiPropertyOptional({ example: 20 })
    remainingDays: number | null;

    @ApiPropertyOptional({ example: 'Customer changed plans' })
    reason: string | null;

    @ApiPropertyOptional({ example: 'uuid-user' })
    requestedBy: string | null;

    @ApiPropertyOptional({ example: 'uuid-admin' })
    approvedBy: string | null;

    @ApiPropertyOptional({ example: '50300000000000' })
    channelRefundId: string | null;

    @ApiPropertyOptional({ example: 'seller balance is not enough' })
    failureReason: string | null;

    @ApiPropertyOptional({ example: '2026-03-05T12:00:00.000Z' })
    refundedAt: Date | null;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    createdAt: Date;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    updatedAt: Date;

    constructor(partial: Partial<AdminRefundEntity>) {
        Object.assign(this, partial);
    }
}
