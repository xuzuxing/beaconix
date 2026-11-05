import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RumAppOverviewTrafficEntity {
    @ApiProperty({ description: 'Page views reported as $pageview' })
    pv: number;

    @ApiProperty({
        description:
            'Distinct actors (user, anonymous id or session) on $pageview',
    })
    uv: number;

    @ApiProperty({ description: 'Clicks reported as $click' })
    clicks: number;
}

export class RumAppOverviewRequestsEntity {
    @ApiProperty({ description: 'HTTP and resource samples in the window' })
    total: number;

    @ApiProperty()
    success: number;

    @ApiProperty()
    failures: number;

    @ApiPropertyOptional({
        nullable: true,
        description: 'success / total as a percentage (0-100)',
    })
    successRate: number | null;

    @ApiPropertyOptional({
        nullable: true,
        description: 'failures / total as a percentage (0-100)',
    })
    errorRate: number | null;

    @ApiPropertyOptional({
        nullable: true,
        description: 'p75 duration in milliseconds',
    })
    p75: number | null;

    @ApiPropertyOptional({
        nullable: true,
        description: 'Average duration in milliseconds',
    })
    average: number | null;
}

export class RumAppOverviewErrorsEntity {
    @ApiProperty({ description: 'Occurrences with a non-manual category' })
    js: number;

    @ApiProperty({
        description: 'Occurrences captured manually (category MANUAL)',
    })
    custom: number;

    @ApiProperty({ description: 'Every error occurrence in the window' })
    total: number;

    @ApiProperty({
        description: 'Business events (everything without a $ prefix)',
    })
    events: number;

    @ApiPropertyOptional({
        nullable: true,
        description:
            'JS errors per page view as a percentage; null when there is no traffic',
    })
    jsRate: number | null;
}

export class RumAppOverviewPointEntity {
    @ApiProperty()
    bucketStart: Date;

    @ApiProperty()
    pv: number;

    @ApiProperty()
    uv: number;

    @ApiProperty()
    clicks: number;

    @ApiProperty()
    requests: number;

    @ApiProperty()
    failures: number;

    @ApiProperty()
    jsErrors: number;

    @ApiProperty()
    customErrors: number;

    @ApiProperty()
    events: number;
}

export class RumAppOverviewEntity {
    @ApiProperty()
    from: Date;

    @ApiProperty()
    to: Date;

    @ApiProperty({ description: 'Bucket size used by the series, in minutes' })
    bucketMinutes: number;

    @ApiProperty({ type: RumAppOverviewTrafficEntity })
    traffic: RumAppOverviewTrafficEntity;

    @ApiProperty({ type: RumAppOverviewRequestsEntity })
    requests: RumAppOverviewRequestsEntity;

    @ApiProperty({ type: RumAppOverviewErrorsEntity })
    errors: RumAppOverviewErrorsEntity;

    @ApiProperty({ type: [RumAppOverviewPointEntity] })
    series: RumAppOverviewPointEntity[];
}
