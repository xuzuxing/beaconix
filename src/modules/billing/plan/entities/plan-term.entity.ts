import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PlanCycle } from '../../../../generated/prisma/enums';

/** One purchasable cycle of a plan (monthly / quarterly / yearly). */
export class PlanTermEntity {
    @ApiProperty({ example: 'clxplanterm0001' })
    id: string;

    @ApiProperty({ example: 'clxplan0001' })
    planId: string;

    @ApiProperty({ enum: PlanCycle, example: PlanCycle.MONTHLY })
    cycle: PlanCycle;

    @ApiProperty({
        example: 30,
        description: 'Term length in days, snapshotted onto the order',
    })
    durationDays: number;

    @ApiProperty({ example: 2900, description: 'Price in cents (分)' })
    price: number;

    @ApiProperty({
        example: true,
        description: 'Disabled terms stay readable for past orders only',
    })
    enabled: boolean;

    @ApiProperty({ example: 1 })
    sortOrder: number;

    @ApiPropertyOptional({
        example: 'beacon_pro_month',
        nullable: true,
        description:
            '小程序虚拟支付道具 ID。为空表示该档位还不能用虚拟支付下单（管理端在 Plan 编辑里映射）。',
    })
    wechatProductId?: string | null;

    constructor(partial: Partial<PlanTermEntity>) {
        Object.assign(this, partial);
    }
}
