import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AdminMetricsOverviewTenantsEntity {
    @ApiProperty({ example: 40 })
    total: number;

    @ApiProperty({ example: 36 })
    active: number;

    @ApiProperty({ example: 4 })
    deleted: number;
}

export class AdminMetricsOverviewMonitorsEntity {
    @ApiProperty({ example: 320 })
    total: number;

    @ApiProperty({ example: 280 })
    enabled: number;
}

export class AdminMetricsOverviewProbesEntity {
    @ApiProperty({ example: 55 })
    total: number;

    @ApiProperty({ example: 45 })
    tenant: number;

    @ApiProperty({ example: 10 })
    system: number;
}

export class AdminMetricsOverviewEntity {
    @ApiProperty({ type: AdminMetricsOverviewTenantsEntity })
    tenants: AdminMetricsOverviewTenantsEntity;

    @ApiProperty({ example: 200 })
    users: number;

    @ApiProperty({ example: 90 })
    projects: number;

    @ApiProperty({ type: AdminMetricsOverviewMonitorsEntity })
    monitors: AdminMetricsOverviewMonitorsEntity;

    @ApiProperty({ type: AdminMetricsOverviewProbesEntity })
    probes: AdminMetricsOverviewProbesEntity;

    @ApiProperty({ example: 180000 })
    checkVolume: number;

    @ApiProperty({ example: 3200 })
    notificationVolume: number;

    @ApiProperty({ example: 12 })
    statusPages: number;

    @ApiProperty({ example: 60 })
    systemProbeUsage: number;

    constructor(partial: Partial<AdminMetricsOverviewEntity>) {
        Object.assign(this, partial);
    }
}

export class AdminTenantMetricEntity {
    @ApiProperty({ example: 'uuid-org' })
    organizationId: string;

    @ApiProperty({ example: 'Acme Corporation' })
    name: string;

    @ApiProperty({ example: 'acme-corp' })
    slug: string;

    @ApiProperty({ example: true })
    active: boolean;

    @ApiProperty({ example: 12 })
    monitorCount: number;

    @ApiProperty({ example: 10 })
    enabledMonitorCount: number;

    @ApiProperty({ example: 3 })
    tenantProbeCount: number;

    @ApiProperty({ example: 5 })
    systemProbeUsage: number;

    @ApiProperty({ example: 9000 })
    checkVolume: number;

    @ApiProperty({ example: 120 })
    notificationVolume: number;

    @ApiProperty({ example: 2 })
    statusPageCount: number;

    constructor(partial: Partial<AdminTenantMetricEntity>) {
        Object.assign(this, partial);
    }
}

export class AdminSchedulerQueueEntity {
    @ApiProperty({ example: 0, description: 'Jobs waiting to be picked up' })
    waiting: number;

    @ApiProperty({ example: 1, description: 'Jobs being processed right now' })
    active: number;

    @ApiProperty({ example: 12, description: 'Jobs scheduled in the future' })
    delayed: number;

    @ApiProperty({ example: 0, description: 'Jobs that ended in failure' })
    failed: number;

    @ApiProperty({ example: 180, description: 'Jobs kept after completion' })
    completed: number;

    constructor(partial: Partial<AdminSchedulerQueueEntity>) {
        Object.assign(this, partial);
    }
}

export class AdminSchedulerJobEntity {
    @ApiProperty({ example: 'monitor-checker' })
    id: string;

    @ApiPropertyOptional({ example: 10000, description: 'Interval in ms' })
    everyMs: number | null;

    @ApiPropertyOptional({
        example: '0 8 * * *',
        description: 'Cron pattern for the job, when it is not interval based',
    })
    pattern: string | null;

    @ApiPropertyOptional({
        example: '2026-10-06T13:00:10.000Z',
        description: 'When the scheduler fires next',
    })
    nextRunAt: Date | null;

    constructor(partial: Partial<AdminSchedulerJobEntity>) {
        Object.assign(this, partial);
    }
}

export class AdminSchedulerBacklogEntity {
    @ApiProperty({ example: 320, description: 'Enabled, non-deleted monitors' })
    enabledMonitors: number;

    @ApiProperty({
        example: 2,
        description:
            'Monitors whose interval elapsed since their last local check',
    })
    dueMonitors: number;

    constructor(partial: Partial<AdminSchedulerBacklogEntity>) {
        Object.assign(this, partial);
    }
}

export class AdminSchedulerProbesEntity {
    @ApiProperty({ example: 45 })
    online: number;

    @ApiProperty({ example: 3 })
    offline: number;

    constructor(partial: Partial<AdminSchedulerProbesEntity>) {
        Object.assign(this, partial);
    }
}

export class AdminSchedulerHealthEntity {
    @ApiProperty({
        type: [String],
        description:
            'Jobs defined on this API instance; compare with Redis schedulers. Execution history is in Prometheus worker metrics.',
    })
    definedJobs: string[];
    @ApiProperty({ type: AdminSchedulerQueueEntity })
    scanQueue: AdminSchedulerQueueEntity;

    @ApiProperty({ type: AdminSchedulerQueueEntity })
    checkQueue: AdminSchedulerQueueEntity;

    @ApiProperty({ type: AdminSchedulerQueueEntity })
    scheduledQueue: AdminSchedulerQueueEntity;

    @ApiProperty({ type: [AdminSchedulerJobEntity] })
    schedulers: AdminSchedulerJobEntity[];

    @ApiProperty({ type: AdminSchedulerBacklogEntity })
    backlog: AdminSchedulerBacklogEntity;

    @ApiProperty({ type: AdminSchedulerProbesEntity })
    probes: AdminSchedulerProbesEntity;

    constructor(partial: Partial<AdminSchedulerHealthEntity>) {
        Object.assign(this, partial);
    }
}
