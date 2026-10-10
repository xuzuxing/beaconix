import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { IsCuid } from '../../../../common/decorators/is-cuid.decorator';

export class CreateOrderDto {
    @ApiProperty({
        example: 'cmgu92m5x0004p8l4h8z6s3k5',
        description: 'Plan CUID',
    })
    @IsCuid()
    planId: string;

    @ApiPropertyOptional({
        example: 30,
        description:
            'Purchase duration in days. Defaults to the plan duration.',
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(3650)
    durationDays?: number;
}
