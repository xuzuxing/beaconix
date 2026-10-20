import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SubscriptionStatus } from '../../../../generated/prisma/enums';
import { PlanEntity } from '../../plan/entities';

export class SubscriptionStackEntryEntity {
    @ApiProperty({ example: 'uuid-subscription' })
    id: string;

    @ApiProperty({ type: PlanEntity })
    plan: PlanEntity;

    @ApiProperty({
        example: '2026-10-20T13:00:00.000Z',
        description: 'When this entry starts (in the future for a queued plan)',
    })
    startsAt: Date;

    @ApiProperty({
        example: '2026-11-01T00:00:00.000Z',
        description:
            'Expiry. For a PAUSED entry this is the expiry frozen at pause time — read `pausedRemainingDays` instead.',
    })
    expiresAt: Date;

    @ApiProperty({
        enum: SubscriptionStatus,
        example: SubscriptionStatus.ACTIVE,
        description:
            'ACTIVE = currently usable (the highest active plan wins). PAUSED = frozen while a higher plan is in effect; its remaining days resume automatically.',
    })
    status: SubscriptionStatus;

    @ApiPropertyOptional({
        example: 100,
        nullable: true,
        description:
            'Frozen remaining days on a PAUSED entry; null for ACTIVE entries.',
    })
    pausedRemainingDays: number | null;

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
