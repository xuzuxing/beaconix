import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RumErrorOverviewTotalsEntity {
    @ApiProperty({ description: 'Error occurrences in the window' })
    errors: number;

    @ApiProperty({ description: 'Occurrences with a non-manual category' })
    js: number;

    @ApiProperty({
        description: 'Occurrences captured manually (category MANUAL)',
    })
    custom: number;

    @ApiProperty({
        description: 'Page views in the window, used as the rate denominator',
    })
    pv: number;

    @ApiPropertyOptional({
        nullable: true,
        description:
            'errors / pv as a percentage; null when there is no traffic',
    })
    errorRate: number | null;

    @ApiProperty({
        description:
            'Distinct actors (user, anonymous id or session) with an error',
    })
    affectedUsers: number;

    @ApiProperty({ description: 'Distinct pages that reported an error' })
    affectedPages: number;

    @ApiProperty({
        description:
            'Error groups still UNRESOLVED for this app (not window scoped)',
    })
    openGroups: number;
}

export class RumErrorOverviewPointEntity {
    @ApiProperty()
    bucketStart: Date;

    @ApiProperty()
    errors: number;

    @ApiProperty()
    js: number;

    @ApiProperty()
    custom: number;

    @ApiProperty()
    pv: number;

    @ApiPropertyOptional({
        nullable: true,
        description:
            'errors / pv for this bucket, null when the bucket has no traffic',
    })
    errorRate: number | null;
}

export class RumErrorOverviewEntity {
    @ApiProperty()
    from: Date;

    @ApiProperty()
    to: Date;

    @ApiProperty({ description: 'Bucket size used by the series, in minutes' })
    bucketMinutes: number;

    @ApiProperty({ type: RumErrorOverviewTotalsEntity })
    totals: RumErrorOverviewTotalsEntity;

    @ApiProperty({ type: [RumErrorOverviewPointEntity] })
    series: RumErrorOverviewPointEntity[];
}
