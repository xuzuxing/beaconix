import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MonitoringOverviewMonitorEntity {
    @ApiProperty({ example: 'uuid-monitor' })
    id: string;

    @ApiProperty({ example: 'Production API' })
    name: string;

    @ApiProperty({ example: 'https://api.example.com/health' })
    target: string;

    @ApiProperty({
        enum: ['UNKNOWN', 'UP', 'DEGRADED', 'DOWN', 'PAUSED'],
        example: 'DOWN',
    })
    status: string;

    @ApiPropertyOptional({ example: '2026-03-05T12:00:00.000Z' })
    lastCheckAt: Date | null;

    @ApiPropertyOptional({ example: 'connect ECONNREFUSED' })
    lastError: string | null;

    constructor(partial: Partial<MonitoringOverviewMonitorEntity>) {
        Object.assign(this, partial);
    }
}

export class MonitoringOverviewCountsEntity {
    @ApiProperty({ example: 12 })
    total: number;

    @ApiProperty({ example: 10 })
    enabled: number;

    @ApiProperty({ example: 2 })
    paused: number;
}

export class MonitoringOverviewStatusCountsEntity {
    @ApiProperty({ example: 0 })
    UNKNOWN: number;

    @ApiProperty({ example: 8 })
    UP: number;

    @ApiProperty({ example: 1 })
    DEGRADED: number;

    @ApiProperty({ example: 1 })
    DOWN: number;

    @ApiProperty({ example: 2 })
    PAUSED: number;
}

export class MonitoringOverviewUptimeEntity {
    @ApiProperty({ example: 1440 })
    totalChecks: number;

    @ApiProperty({ example: 1435 })
    successfulChecks: number;

    @ApiPropertyOptional({ example: 99.65 })
    uptimePercent: number | null;
}

export class MonitoringOverviewEntity {
    @ApiProperty({ type: MonitoringOverviewCountsEntity })
    monitors: MonitoringOverviewCountsEntity;

    @ApiProperty({ type: MonitoringOverviewStatusCountsEntity })
    byStatus: MonitoringOverviewStatusCountsEntity;

    @ApiProperty({ type: [MonitoringOverviewMonitorEntity] })
    recentIncidents: MonitoringOverviewMonitorEntity[];

    @ApiPropertyOptional({ example: 128 })
    avgLatency: number | null;

    @ApiProperty({ type: MonitoringOverviewUptimeEntity })
    uptime: MonitoringOverviewUptimeEntity;

    @ApiProperty({ example: 2 })
    sslExpiringSoon: number;

    constructor(partial: Partial<MonitoringOverviewEntity>) {
        Object.assign(this, partial);
    }
}
