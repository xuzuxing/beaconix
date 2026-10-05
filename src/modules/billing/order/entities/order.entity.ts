import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PlanEntity } from '../../plan/entities';

export class OrderEntity {
    @ApiProperty({ example: 'uuid-order' })
    id: string;

    @ApiProperty({ example: 'BWMB3KXABC123' })
    orderNo: string;

    @ApiProperty({ example: 'uuid-org' })
    organizationId: string;

    @ApiProperty({ example: 'uuid-plan' })
    planId: string;

    @ApiProperty({ example: 'uuid-user' })
    userId: string;

    @ApiProperty({ example: 2900, description: 'Amount in cents' })
    amount: number;

    @ApiProperty({ example: 'CNY' })
    currency: string;

    @ApiProperty({ example: 30 })
    durationDays: number;

    @ApiProperty({
        enum: ['PENDING', 'PAID', 'CANCELLED', 'REFUNDED'],
        example: 'PENDING',
    })
    status: string;

    @ApiPropertyOptional({ example: '2026-03-05T12:00:00.000Z' })
    paidAt: Date | null;

    @ApiPropertyOptional({ example: '2026-03-05T12:00:00.000Z' })
    cancelledAt: Date | null;

    @ApiProperty({ example: '2026-03-05T12:30:00.000Z' })
    expiresAt: Date;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    createdAt: Date;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    updatedAt: Date;

    @ApiPropertyOptional({ type: PlanEntity })
    plan?: PlanEntity | null;

    constructor(partial: Partial<OrderEntity>) {
        Object.assign(this, partial);
    }
}
