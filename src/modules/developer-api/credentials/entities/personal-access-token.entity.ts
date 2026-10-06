import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PersonalAccessTokenEntity {
    @ApiProperty({ example: 'uuid-pat' })
    id: string;

    @ApiProperty({ example: 'uuid-user' })
    userId: string;

    @ApiProperty({ example: 'My laptop' })
    name: string;

    @ApiProperty({ isArray: true, type: String, example: ['monitors:read'] })
    scopes: string[];

    @ApiPropertyOptional({ example: '2026-12-31T23:59:59.000Z' })
    expiresAt: Date | null;

    @ApiPropertyOptional({ example: '2026-03-05T12:00:00.000Z' })
    lastUsedAt: Date | null;

    @ApiPropertyOptional({ example: null })
    revokedAt: Date | null;

    @ApiProperty()
    createdAt: Date;

    @ApiProperty()
    updatedAt: Date;

    /** Only populated once, when the token is created. */
    @ApiPropertyOptional({ example: 'bk_pat_...' })
    token?: string;

    constructor(partial: Partial<PersonalAccessTokenEntity>) {
        Object.assign(this, partial);
    }
}
