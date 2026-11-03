import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RumAppPlatform } from '../../../generated/prisma/enums';

export class RumAppEntity {
    @ApiProperty()
    id: string;

    @ApiProperty()
    organizationId: string;

    @ApiProperty()
    projectId: string;

    @ApiProperty({ example: 'Customer portal' })
    name: string;

    @ApiProperty({ enum: RumAppPlatform })
    platform: RumAppPlatform;

    @ApiProperty({ example: 'rum_m7m1RrVb3hO9YkQe8Jp2p1sA' })
    publicKey: string;

    @ApiProperty()
    enabled: boolean;

    @ApiPropertyOptional({ nullable: true })
    createdById: string | null;

    @ApiProperty()
    createdAt: Date;

    @ApiProperty()
    updatedAt: Date;

    @ApiPropertyOptional({ nullable: true })
    deletedAt: Date | null;
}
