import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

export class PublicStatusPageMonitorEntity {
    @ApiProperty({ example: 'uuid-monitor' })
    id: string;

    @ApiProperty({ example: 'Production API' })
    name: string;

    @ApiProperty({ enum: ['HTTP', 'TCP'], example: 'HTTP' })
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
