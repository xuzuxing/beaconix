import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MonitorType } from '../../../generated/prisma/enums';

export class StatusPageEntity {
    @ApiProperty({ example: 'uuid-status-page' })
    id: string;

    @ApiProperty({ example: 'uuid-org' })
    organizationId: string;

    @ApiProperty({ example: 'acme-status' })
    slug: string;

    @ApiProperty({ example: 'Acme status' })
    title: string;

    @ApiPropertyOptional({ example: 'Public status for the Acme platform' })
    description: string | null;

    @ApiProperty({ type: [String], example: ['monitor-uuid-1'] })
    visibleMonitorIds: string[];

    @ApiProperty({ example: true })
    showLatency: boolean;

    @ApiProperty({ example: false })
    showUptime: boolean;

    @ApiProperty({ example: true })
    enabled: boolean;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    createdAt: Date;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    updatedAt: Date;

    constructor(partial: Partial<StatusPageEntity>) {
        Object.assign(this, partial);
    }
}

export class PublicMonitorAvailabilityHistoryEntity {
    @ApiProperty({ example: 90 })
    retentionDays: number;

    @ApiProperty({ example: '2026-07-12T18:32:00.000+08:00' })
    availableFrom: string;

    @ApiProperty({ enum: ['AVAILABLE', 'TRUNCATED'], example: 'AVAILABLE' })
    status: string;

    constructor(partial: Partial<PublicMonitorAvailabilityHistoryEntity>) {
        Object.assign(this, partial);
    }
}

export class PublicMonitorAvailabilityWorstEntity {
    @ApiProperty({ example: '2026-10-10' })
    day: string;

    @ApiProperty({ example: 18 })
    hour: number;

    @ApiProperty({ example: 50 })
    value: number;
}

export class PublicMonitorAvailabilityEntity {
    @ApiProperty({ example: 'Asia/Shanghai' })
    tz: string;

    @ApiProperty({
        example: '2026-10-10T18:32:00.000+08:00',
        description: 'Aggregation snapshot, expressed in the requested zone',
    })
    asOf: string;

    @ApiProperty({ example: '2026-10-08' })
    from: string;

    @ApiProperty({ example: '2026-10-10' })
    to: string;

    @ApiProperty({ type: PublicMonitorAvailabilityHistoryEntity })
    history: PublicMonitorAvailabilityHistoryEntity;

    @ApiProperty({
        type: [Number],
        example: [0, 1, 2, 3],
        description: 'Local hours 0-23',
    })
    hours: number[];

    @ApiProperty({
        type: [String],
        example: ['2026-10-08', '2026-10-09', '2026-10-10'],
        description: 'Local dates, oldest first',
    })
    days: string[];

    @ApiProperty({
        type: 'array',
        items: { type: 'array', items: { type: 'number' } },
        example: [
            [0, 0, 100],
            [18, 2, 50],
        ],
        description:
            '[hourIndex, dayIndex, uptimePercent]; hours without samples are absent',
    })
    cells: number[][];

    @ApiProperty({
        type: 'array',
        items: { type: 'array', items: { type: 'number' } },
        example: [[3, 0]],
        description:
            '[hourIndex, dayIndex] cells whose interval reaches before the reliable history start',
    })
    unavailableCells: number[][];

    @ApiPropertyOptional({
        type: PublicMonitorAvailabilityWorstEntity,
        nullable: true,
        description: 'Lowest cell of the grid; null when the grid has no cells',
    })
    worst: PublicMonitorAvailabilityWorstEntity | null;

    constructor(partial: Partial<PublicMonitorAvailabilityEntity>) {
        Object.assign(this, partial);
    }
}

export class PublicStatusPageMonitorEntity {
    @ApiProperty({ example: 'uuid-monitor' })
    id: string;

    @ApiProperty({ example: 'Production API' })
    name: string;

    @ApiProperty({ enum: MonitorType, example: 'HTTP' })
    type: string;

    @ApiProperty({ example: 'https://api.example.com/health' })
    target: string;

    @ApiProperty({
        enum: ['UNKNOWN', 'UP', 'DEGRADED', 'DOWN', 'PAUSED'],
        example: 'UP',
    })
    status: string;

    @ApiPropertyOptional({ example: '2026-03-05T12:00:00.000Z' })
    lastCheckAt: Date | null;

    @ApiPropertyOptional({
        example: 128,
        description: 'Present when the page has showLatency enabled',
    })
    latency?: number | null;

    @ApiPropertyOptional({
        example: 99.5,
        description: 'Present when the page has showUptime enabled',
    })
    uptimePercent?: number | null;

    @ApiPropertyOptional({
        type: PublicMonitorAvailabilityEntity,
        description:
            'Hourly LOCAL availability of the last 3 local days. Present when the page has showUptime enabled.',
    })
    availability?: PublicMonitorAvailabilityEntity;

    constructor(partial: Partial<PublicStatusPageMonitorEntity>) {
        Object.assign(this, partial);
    }
}

export class PublicStatusPageEntity {
    @ApiProperty({ example: 'acme-status' })
    slug: string;

    @ApiProperty({ example: 'Acme status' })
    title: string;

    @ApiPropertyOptional({ example: 'Public status for the Acme platform' })
    description: string | null;

    @ApiProperty({
        enum: ['UNKNOWN', 'UP', 'DEGRADED', 'DOWN', 'PAUSED'],
        example: 'UP',
    })
    overallStatus: string;

    @ApiProperty({ example: true })
    showLatency: boolean;

    @ApiProperty({ example: false })
    showUptime: boolean;

    @ApiProperty({ type: [PublicStatusPageMonitorEntity] })
    monitors: PublicStatusPageMonitorEntity[];

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    updatedAt: Date;

    constructor(partial: Partial<PublicStatusPageEntity>) {
        Object.assign(this, partial);
    }
}
