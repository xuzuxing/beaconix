import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';

/** A monitor attached to a probe, as exposed by the probe endpoints. */
export class ProbeMonitorEntity {
    @ApiProperty({ example: 'uuid-monitor' })
    id: string;

    @ApiProperty({ example: 'Production API' })
    name: string;

    @ApiProperty({ enum: ['HTTP', 'TCP'], example: 'HTTP' })
    type: string;

    @ApiProperty({ example: 'https://api.example.com/health' })
    target: string;

    @ApiProperty({ example: true })
    enabled: boolean;

    constructor(partial: Partial<ProbeMonitorEntity>) {
        Object.assign(this, partial);
    }
}

export class ProbeEntity {
    @ApiProperty({ example: 'uuid-probe' })
    id: string;

    @ApiPropertyOptional({ example: 'uuid-org' })
    organizationId: string | null;

    @ApiProperty({ enum: ['SYSTEM', 'TENANT'], example: 'TENANT' })
    scope: string;

    @ApiProperty({ example: 'Tokyo probe' })
    name: string;

    @ApiProperty({
        enum: ['TENCENT', 'ALIYUN', 'CUSTOM'],
        example: 'TENCENT',
    })
    provider: string;

    @ApiProperty({ example: 'ap-northeast-1' })
    region: string;

    @ApiProperty({ example: 'https://probe.example.com/beacon/callback' })
    callbackUrl: string;

    @ApiPropertyOptional({
        example: 'tnt_1a2b3c4d...',
        description:
            'Shared secret the probe sends as x-probe-secret. Returned ONLY on the create and rotate responses — never on subsequent reads.',
    })
    secret?: string;

    @ApiProperty({ example: true })
    enabled: boolean;

    @ApiPropertyOptional({ example: '2026-03-05T12:00:00.000Z' })
    lastHeartbeat: Date | null;

    @ApiPropertyOptional({
        example: 60,
        description:
            'Heartbeat interval the probe reported; the offline threshold is three times this value',
    })
    heartbeatIntervalSeconds: number | null;

    @ApiProperty({ enum: ['ONLINE', 'OFFLINE'], example: 'ONLINE' })
    status: string;

    @ApiPropertyOptional({
        example: 100,
        description: 'Maximum tenants assigned to a system probe',
    })
    maxTenants: number | null;

    @ApiProperty({
        example: 0,
        description: 'Scheduling priority for system probes',
    })
    priority: number;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    createdAt: Date;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    updatedAt: Date;

    @ApiProperty({ type: [ProbeMonitorEntity] })
    monitors: ProbeMonitorEntity[];

    @ApiPropertyOptional({
        example: 12,
        description: 'Number of stored probe results',
    })
    resultCount?: number;

    @Exclude()
    deletedAt?: Date | null;

    constructor(partial: Partial<ProbeEntity>) {
        Object.assign(this, partial);
    }
}
