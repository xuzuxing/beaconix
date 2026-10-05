import { ApiProperty } from '@nestjs/swagger';

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
