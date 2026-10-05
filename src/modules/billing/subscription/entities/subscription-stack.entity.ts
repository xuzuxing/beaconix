import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PlanEntity } from '../../plan/entities';

export class SubscriptionStackEntryEntity {
    @ApiProperty({ example: 'uuid-subscription' })
    id: string;

    @ApiProperty({ type: PlanEntity })
    plan: PlanEntity;

    @ApiProperty({ example: '2026-11-01T00:00:00.000Z' })
    expiresAt: Date;

    @ApiProperty({ example: true })
    isEffective: boolean;

    constructor(partial: Partial<SubscriptionStackEntryEntity>) {
        Object.assign(this, partial);
    }
}

export class SubscriptionStackEntity {
    @ApiPropertyOptional({ type: PlanEntity })
    effectivePlan: PlanEntity | null;

    @ApiProperty({ type: [SubscriptionStackEntryEntity] })
    stack: SubscriptionStackEntryEntity[];

    constructor(partial: Partial<SubscriptionStackEntity>) {
        Object.assign(this, partial);
    }
}
