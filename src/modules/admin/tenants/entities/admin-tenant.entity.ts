import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AdminTenantEntity {
    @ApiProperty({ example: 'uuid-org' })
    id: string;

    @ApiProperty({ example: 'Acme Corporation' })
    name: string;

    @ApiProperty({ example: 'acme-corp' })
    slug: string;

    @ApiProperty({ example: 'uuid-owner' })
    ownerId: string;

    @ApiProperty({ example: true })
    active: boolean;

    @ApiProperty({ example: 12 })
    memberCount: number;

    @ApiProperty({ example: 3 })
    projectCount: number;

    @ApiProperty({ example: 8 })
    monitorCount: number;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    createdAt: Date;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    updatedAt: Date;

    @ApiPropertyOptional({ example: '2026-03-06T12:00:00.000Z' })
    deletedAt: Date | null;

    constructor(partial: Partial<AdminTenantEntity>) {
        Object.assign(this, partial);
    }
}
