import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TicketCategoryEntity {
    @ApiProperty({ example: 'cmgu92m5x0002p8l4h8z6s3k3' })
    id: string;

    @ApiProperty({ example: 'Billing' })
    name: string;

    @ApiPropertyOptional({ nullable: true })
    description: string | null;

    @ApiProperty({ example: 0 })
    sortOrder: number;

    @ApiProperty({ example: true })
    isActive: boolean;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    createdAt: Date;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    updatedAt: Date;

    constructor(partial: Partial<TicketCategoryEntity>) {
        Object.assign(this, partial);
    }
}
