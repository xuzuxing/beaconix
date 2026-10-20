import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { IsCuid } from '../../../../common/decorators/is-cuid.decorator';
import { PlanCycle } from '../../../../generated/prisma/enums';

export class CreateOrderDto {
    @ApiProperty({
        example: 'cmgu92m5x0004p8l4h8z6s3k5',
        description: 'Plan CUID',
    })
    @IsCuid()
    planId: string;

    @ApiPropertyOptional({
        enum: PlanCycle,
        description:
            "Billing cycle to buy. Defaults to the plan's cheapest enabled cycle. The term's own price and duration are used, so clients cannot pick an arbitrary number of days.",
    })
    @IsOptional()
    @IsEnum(PlanCycle)
    cycle?: PlanCycle;
}
