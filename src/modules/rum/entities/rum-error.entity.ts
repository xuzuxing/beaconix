import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RumErrorGroupEntity {
    @ApiProperty()
    id: string;

    @ApiProperty()
    appId: string;

    @ApiProperty()
    fingerprint: string;

    @ApiProperty()
    fingerprintVersion: number;

    @ApiProperty()
    type: string;

    @ApiProperty()
    message: string;

    @ApiPropertyOptional({ nullable: true })
    stack: string | null;

    @ApiPropertyOptional({ nullable: true })
    page: string | null;

    @ApiProperty()
    count: number;

    @ApiProperty()
    firstSeenAt: Date;

    @ApiProperty()
    lastSeenAt: Date;

    @ApiPropertyOptional({ nullable: true })
    firstOccurredAt: Date | null;

    @ApiPropertyOptional({ nullable: true })
    lastOccurredAt: Date | null;

    @ApiProperty()
    createdAt: Date;

    @ApiProperty()
    updatedAt: Date;
}

export class RumErrorGroupListEntity {
    @ApiProperty({ type: [RumErrorGroupEntity] })
    items: RumErrorGroupEntity[];

    @ApiProperty()
    total: number;

    @ApiProperty()
    page: number;

    @ApiProperty()
    limit: number;
}
