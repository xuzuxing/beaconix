import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CheckLogEntity } from './check-log.entity';

/**
 * Verdict aggregation recorded on the settled batch row
 * (`CheckLog.meta.aggregation`). Null while the batch is still open.
 */
export class CheckRoundAggregationEntity {
    @ApiProperty({
        example: false,
        description:
            'True when the batch was protected and settled with the local verdict only',
    })
    protected: boolean;

    @ApiPropertyOptional({
        enum: ['LEGACY_UNSUPPORTED', 'UNEVALUATED', 'ASSERTION', 'SSL'],
        example: null,
    })
    protectedReason:
        'LEGACY_UNSUPPORTED' | 'UNEVALUATED' | 'ASSERTION' | 'SSL' | null;

    @ApiProperty({
        example: 3,
        description: 'Bound online tenant probes: the ratio denominator',
    })
    effectiveProbeCount: number;

    @ApiProperty({
        example: 3,
        description:
            'Samples that took part in the vote (at most one per probe)',
    })
    sampleCount: number;

    @ApiProperty({ example: 2 })
    successCount: number;

    @ApiProperty({ example: 66.67 })
    ratio: number;

    @ApiProperty({ example: 60 })
    threshold: number;

    @ApiProperty({
        enum: [
            'RESCUED',
            'OVERTURNED',
            'CONFIRMED_SUCCESS',
            'CONFIRMED_FAILURE',
            'FALLBACK_LOCAL',
        ],
        example: 'CONFIRMED_SUCCESS',
    })
    decision:
        | 'RESCUED'
        | 'OVERTURNED'
        | 'CONFIRMED_SUCCESS'
        | 'CONFIRMED_FAILURE'
        | 'FALLBACK_LOCAL';

    @ApiProperty({ example: '2026-03-05T12:01:00.000Z' })
    settledAt: string;
}

/** Probe snapshot attached to a report: who observed the batch. */
export class CheckRoundProbeEntity {
    @ApiProperty({ example: 'uuid-probe' })
    id: string;

    @ApiProperty({ example: 'Tokyo probe' })
    name: string;

    @ApiProperty({ enum: ['SYSTEM', 'TENANT'], example: 'TENANT' })
    scope: string;

    @ApiProperty({ enum: ['TENCENT', 'ALIYUN', 'CUSTOM'], example: 'TENCENT' })
    provider: string;

    @ApiProperty({ example: 'ap-northeast-1' })
    region: string;

    @ApiProperty({ enum: ['ONLINE', 'OFFLINE'], example: 'ONLINE' })
    status: string;

    @ApiProperty({ example: true })
    enabled: boolean;

    @ApiPropertyOptional({ example: '2026-03-05T12:00:00.000Z' })
    lastHeartbeat: Date | null;

    constructor(partial: Partial<CheckRoundProbeEntity>) {
        Object.assign(this, partial);
    }
}

/** One probe report that carried the batch's `roundId`. */
export class CheckRoundProbeResultEntity {
    @ApiProperty({ example: 'uuid-result' })
    id: string;

    @ApiProperty({ example: 'uuid-probe' })
    probeId: string;

    @ApiPropertyOptional({
        type: CheckRoundProbeEntity,
        description: 'Null when the probe was deleted after reporting',
    })
    probe: CheckRoundProbeEntity | null;

    @ApiProperty({ example: true })
    success: boolean;

    @ApiPropertyOptional({ example: 'connect ECONNREFUSED' })
    error: string | null;

    @ApiProperty({ example: 128, description: 'Round-trip time in ms' })
    latency: number;

    @ApiPropertyOptional({
        example: 200,
        description:
            'Observed HTTP status code; null when there was no response',
    })
    statusCode: number | null;

    @ApiProperty({ example: 'https://api.example.com/health' })
    target: string;

    @ApiProperty({ example: '2026-03-05T12:00:10.000Z' })
    checkedAt: Date;

    @ApiProperty({ example: '2026-03-05T12:00:12.000Z' })
    receivedAt: Date;

    @ApiPropertyOptional({
        example: null,
        description:
            'Set once the report was folded into a settlement; null means it was ignored (stale, orphan or outvoted)',
    })
    appliedAt: Date | null;

    constructor(partial: Partial<CheckRoundProbeResultEntity>) {
        Object.assign(this, partial);
    }
}

/**
 * One check batch (round): the local check row that anchored it plus every
 * probe report that carried its `roundId`.
 */
export class CheckRoundEntity {
    @ApiProperty({ example: 'cmgu92m5x0005p8l4h8z6s3k6:1709620800000' })
    roundId: string;

    @ApiProperty({
        example: true,
        description:
            'False while the batch is still collecting probe reports (appliedAt is null)',
    })
    settled: boolean;

    @ApiProperty({
        type: CheckLogEntity,
        description:
            'The batch row: local verdict until settlement, aggregated verdict after',
    })
    check: CheckLogEntity;

    @ApiPropertyOptional({
        type: CheckRoundAggregationEntity,
        description:
            'Aggregation written at settlement; null while the batch is open',
    })
    aggregation: CheckRoundAggregationEntity | null;

    @ApiProperty({
        type: [CheckRoundProbeResultEntity],
        description:
            'Probe reports attributed to this batch, each with the probe that reported it',
    })
    results: CheckRoundProbeResultEntity[];

    constructor(partial: Partial<CheckRoundEntity>) {
        Object.assign(this, partial);
    }
}
