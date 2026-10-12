import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PlanEntity } from '../../../billing/plan/entities';

/** Owning tenant of an order, flattened for the platform-wide order table. */
export class AdminOrderOrganizationEntity {
    @ApiProperty({ example: 'uuid-org' })
    id: string;

    @ApiProperty({ example: 'Acme Corporation' })
    name: string;

    @ApiProperty({ example: 'acme-corp' })
    slug: string;

    constructor(partial: Partial<AdminOrderOrganizationEntity>) {
        Object.assign(this, partial);
    }
}

/** Buyer of an order, flattened so the admin table needs no extra lookup. */
export class AdminOrderUserEntity {
    @ApiProperty({ example: 'uuid-user' })
    id: string;

    @ApiProperty({ example: 'Ada Lovelace' })
    name: string;

    @ApiProperty({ example: 'ada@example.com' })
    email: string;

    constructor(partial: Partial<AdminOrderUserEntity>) {
        Object.assign(this, partial);
    }
}

export class AdminOrderEntity {
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

    @ApiPropertyOptional({ type: AdminOrderOrganizationEntity })
    organization?: AdminOrderOrganizationEntity | null;

    @ApiPropertyOptional({ type: AdminOrderUserEntity })
    user?: AdminOrderUserEntity | null;

    constructor(partial: Partial<AdminOrderEntity>) {
        Object.assign(this, partial);
    }
}
