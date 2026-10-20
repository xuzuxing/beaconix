import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsBoolean,
    IsEnum,
    IsInt,
    IsOptional,
    Max,
    Min,
} from 'class-validator';
import { PlanCycle } from '../../../../generated/prisma/enums';

/** Conventional term length per cycle — only used for examples/seed data. */
export const PLAN_CYCLE_DEFAULT_DAYS: Record<PlanCycle, number> = {
    [PlanCycle.MONTHLY]: 30,
    [PlanCycle.QUARTERLY]: 90,
    [PlanCycle.YEARLY]: 365,
};

/**
 * One purchasable cycle of a plan. `(planId, cycle)` is unique, so a cycle
 * appears at most once per plan; `cycle` is the upsert key on PATCH.
 */
export class CreatePlanTermDto {
    @ApiProperty({
        enum: PlanCycle,
        example: PlanCycle.MONTHLY,
        description: 'Billing cycle. One entry per cycle per plan.',
    })
    @IsEnum(PlanCycle)
    cycle: PlanCycle;

    @ApiProperty({
        example: 30,
        minimum: 1,
        maximum: 3650,
        description:
            'Term length in days, snapshotted onto the order at purchase time (30 / 90 / 365 by convention).',
    })
    @IsInt()
    @Min(1)
    @Max(3650)
    durationDays: number;

    @ApiProperty({
        example: 2900,
        minimum: 0,
        description: 'Price of this cycle in cents (分).',
    })
    @IsInt()
    @Min(0)
    price: number;

    @ApiPropertyOptional({
        example: true,
        default: true,
        description:
            'Disabled terms stay readable for past orders but can no longer be purchased.',
    })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;

    @ApiPropertyOptional({ example: 1, default: 0, minimum: 0 })
    @IsOptional()
    @IsInt()
    @Min(0)
    sortOrder?: number;
}
