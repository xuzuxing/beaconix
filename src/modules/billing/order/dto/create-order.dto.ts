import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class CreateOrderDto {
    @ApiProperty({ example: 'uuid-plan', description: 'Plan UUID' })
    @IsUUID()
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
