import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApiKeyEntity {
    @ApiProperty({ example: 'uuid-api-key' })
    id: string;

    @ApiProperty({ example: 'uuid-org' })
    organizationId: string;

    @ApiProperty({ example: 'Production CI' })
    name: string;

    @ApiProperty({ example: 'bk_org_1a2b3c4d', description: 'Display prefix' })
    keyPrefix: string;

    @ApiProperty({ isArray: true, type: String, example: ['monitors:read'] })
    scopes: string[];

    @ApiPropertyOptional({ example: '2026-12-31T23:59:59.000Z' })
    expiresAt: Date | null;

    @ApiPropertyOptional({ example: '2026-03-05T12:00:00.000Z' })
    lastUsedAt: Date | null;

    @ApiPropertyOptional({ example: null })
    revokedAt: Date | null;

    @ApiPropertyOptional()
    createdById: string | null;

    @ApiProperty()
    createdAt: Date;

    @ApiProperty()
    updatedAt: Date;

    /** Only populated once, when the key is created. */
    @ApiPropertyOptional({ example: 'bk_org_...' })
    key?: string;

    constructor(partial: Partial<ApiKeyEntity>) {
        Object.assign(this, partial);
    }
}
