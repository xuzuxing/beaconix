import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RumErrorStatus } from '../../../generated/prisma/enums';

export class RumReleaseSummaryEntity {
    @ApiPropertyOptional({ nullable: true })
    release: string | null;

    @ApiProperty({ description: 'True for reports without a release tag' })
    isUnknown: boolean;

    @ApiPropertyOptional({ nullable: true })
    firstSeenAt: Date | null;

    @ApiPropertyOptional({ nullable: true })
    lastSeenAt: Date | null;

    @ApiProperty()
    errorGroups: number;

    @ApiProperty()
    occurrences: number;

    @ApiProperty()
    events: number;

    @ApiProperty()
    replays: number;
}

export class RumReleaseListEntity {
    @ApiProperty({ type: [RumReleaseSummaryEntity] })
    items: RumReleaseSummaryEntity[];

    @ApiProperty()
    total: number;
}

export class RumReleaseGroupEntity {
    @ApiProperty()
    id: string;

    @ApiProperty()
    type: string;

    @ApiPropertyOptional({ nullable: true })
    category: string | null;

    @ApiPropertyOptional({ nullable: true })
    level: string | null;

    @ApiProperty()
    message: string;

    @ApiPropertyOptional({ nullable: true })
    page: string | null;

    @ApiPropertyOptional({ nullable: true })
    release: string | null;

    @ApiProperty({ enum: RumErrorStatus })
    status: RumErrorStatus;

    @ApiProperty()
    count: number;

    @ApiProperty()
    firstSeenAt: Date;

    @ApiProperty()
    lastSeenAt: Date;
}

export class RumReleaseCompareEntity {
    @ApiProperty({ type: Object })
    base: { release: string | null; isUnknown: boolean };

    @ApiProperty({ type: Object })
    target: { release: string | null; isUnknown: boolean };

    @ApiPropertyOptional({ nullable: true })
    baseStartedAt: Date | null;

    @ApiProperty({ type: [RumReleaseGroupEntity] })
    new: RumReleaseGroupEntity[];

    @ApiProperty({ type: [RumReleaseGroupEntity] })
    fixed: RumReleaseGroupEntity[];

    @ApiProperty({ type: [RumReleaseGroupEntity] })
    regressed: RumReleaseGroupEntity[];

    @ApiProperty({ type: Object })
    counts: { new: number; fixed: number; regressed: number };
}
