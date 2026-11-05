import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RumPerformancePointEntity {
    @ApiProperty()
    bucketStart: Date;

    @ApiProperty()
    count: number;

    @ApiPropertyOptional({ nullable: true })
    average: number | null;

    @ApiPropertyOptional({ nullable: true })
    p75: number | null;
}

export class RumPerformanceStatsEntity {
    @ApiProperty()
    metric: string;

    @ApiProperty()
    count: number;

    @ApiPropertyOptional({ nullable: true })
    average: number | null;

    @ApiPropertyOptional({ nullable: true })
    p75: number | null;

    @ApiProperty()
    good: number;

    @ApiProperty()
    needsImprovement: number;

    @ApiProperty()
    poor: number;

    @ApiProperty()
    failures: number;
}

export class RumPerformanceSeriesEntity {
    @ApiProperty()
    metric: string;

    @ApiProperty({ type: [RumPerformancePointEntity] })
    points: RumPerformancePointEntity[];

    @ApiProperty({ type: RumPerformanceStatsEntity })
    current: RumPerformanceStatsEntity & {
        rating: string | null;
        changePercent: number | null;
    };

    @ApiProperty({ type: RumPerformanceStatsEntity })
    previous: RumPerformanceStatsEntity;
}

export class RumPerformanceResponseEntity {
    @ApiProperty()
    from: Date;

    @ApiProperty()
    to: Date;

    @ApiProperty({ type: [RumPerformanceSeriesEntity] })
    series: RumPerformanceSeriesEntity[];
}

export class RumPerformanceSummaryEntity {
    @ApiProperty({ type: [Object] })
    metrics: Array<
        RumPerformanceStatsEntity & {
            rating: string | null;
            goodRate: number | null;
            poorRate: number | null;
        }
    >;
}

export class RumPerformancePageEntity {
    @ApiProperty()
    page: string;

    @ApiProperty()
    samples: number;

    @ApiPropertyOptional({ nullable: true })
    p75: number | null;

    @ApiProperty()
    errors: number;

    @ApiPropertyOptional({ nullable: true })
    errorRate: number | null;
}

export class RumPerformancePagesEntity {
    @ApiProperty({ type: [RumPerformancePageEntity] })
    items: RumPerformancePageEntity[];
}

export class RumPerformanceResourceEntity {
    @ApiProperty()
    dimension: string;

    @ApiProperty()
    samples: number;

    @ApiPropertyOptional({ nullable: true })
    p75: number | null;

    @ApiProperty()
    failures: number;

    @ApiPropertyOptional({ nullable: true })
    failureRate: number | null;
}

export class RumPerformanceResourcesEntity {
    @ApiProperty({ type: [RumPerformanceResourceEntity] })
    items: RumPerformanceResourceEntity[];
}
