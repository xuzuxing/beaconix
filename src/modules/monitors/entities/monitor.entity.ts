import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';
import { MonitorType } from '../../../generated/prisma/enums';
import type { JsonValue } from '../../../generated/prisma/internal/prismaNamespace';
import { MONITOR_CONFIG_API_OPTIONS } from '../dto/monitor-config.schema';

/** A tenant probe assigned to a monitor, as exposed by the monitor endpoints. */
export class MonitorProbeEntity {
    @ApiProperty({ example: 'uuid-probe' })
    id: string;

    @ApiProperty({ example: 'Tokyo probe' })
    name: string;

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

    constructor(partial: Partial<MonitorProbeEntity>) {
        Object.assign(this, partial);
    }
}

export class MonitorEntity {
    @ApiProperty({ example: 'uuid-here' })
    id: string;

    @ApiProperty({ example: 'uuid-org' })
    organizationId: string;

    @ApiProperty({ example: 'uuid-project' })
    projectId: string;

    @ApiProperty({ example: 'Production API' })
    name: string;

    @ApiProperty({ enum: MonitorType, example: 'HTTP' })
    type: string;

    @ApiProperty(MONITOR_CONFIG_API_OPTIONS)
    config: JsonValue;

    @ApiProperty({
        description:
            'Credentials are configured; their values are never returned',
    })
    hasCredentials: boolean;

    @ApiProperty({ example: 1 })
    configVersion: number;

    @ApiProperty({ example: 1 })
    revision: number;

    @ApiProperty({ example: true })
    executionEligible: boolean;

    @ApiPropertyOptional({ example: 'MONITOR_TYPE_NOT_ALLOWED' })
    executionBlockedReason: string | null;

    @ApiProperty({ example: 'https://api.example.com/health' })
    target: string;

    @ApiProperty({ example: 60, description: 'Seconds between checks' })
    interval: number;

    @ApiProperty({ example: 5000, description: 'Timeout in milliseconds' })
    timeout: number;

    @ApiProperty({ example: 200, description: 'Expected HTTP status code' })
    expectedStatus: number;

    @ApiProperty({ example: 3, description: 'Failures before DOWN' })
    failureThreshold: number;

    @ApiProperty({
        example: 100,
        minimum: 1,
        maximum: 100,
        default: 100,
        description:
            'Minimum success percentage of the voting probes, 1-100 (100 = every voting probe must succeed). The denominator is what actually reported; the local check only decides when nothing reported',
    })
    probeSuccessRatio: number;

    @ApiProperty({
        example: false,
        description:
            'True: assigned system probes still run and report but stay out of the ratio (tenant probes only)',
    })
    tenantProbesOnly: boolean;

    @ApiProperty({
        example: true,
        description: 'Whether HTTPS certificate expiry is monitored',
    })
    checkSsl: boolean;

    @ApiProperty({
        example: 30,
        description: 'Days before SSL certificate expiry that should alert',
    })
    sslExpiryThreshold: number;

    @ApiProperty({ example: true })
    enabled: boolean;

    @ApiProperty({
        example: false,
        description: 'Whether availability-based alerting is enabled',
    })
    availabilityEnabled: boolean;

    @ApiPropertyOptional({
        example: 90,
        description: 'Availability threshold in percent',
    })
    availabilityThreshold: number | null;

    @ApiPropertyOptional({
        example: 10,
        description:
            'Number of most recent checks used to compute availability',
    })
    availabilityWindow: number | null;

    @ApiProperty({
        example: ['clx123channel1'],
        description:
            'Bound notification channel IDs (empty = org-wide fallback)',
        type: [String],
    })
    notificationChannelIds: string[];

    @ApiPropertyOptional({
        type: [MonitorProbeEntity],
        description:
            'Tenant probes currently assigned to this monitor (reporting only; probes vote on every check). Omitted from list responses',
    })
    probes?: MonitorProbeEntity[];

    @ApiProperty({
        example: 10,
        description:
            'Maximum tenant probes the current plan allows per monitor (0 = manual assignment unavailable)',
    })
    maxProbes: number;

    // ── Runtime state (flattened from MonitorState) ─────────────────────
    @ApiProperty({
        enum: ['UNKNOWN', 'UP', 'DEGRADED', 'DOWN', 'PAUSED'],
        example: 'UNKNOWN',
    })
    status: string;

    @ApiProperty({ example: 0, description: 'Consecutive failures so far' })
    failCount: number;

    @ApiPropertyOptional({ example: '2026-03-05T12:00:00.000Z' })
    lastCheckAt: Date | null;

    @ApiPropertyOptional({ example: 128, description: 'Last latency in ms' })
    lastLatency: number | null;

    @ApiPropertyOptional({ example: 'connect ECONNREFUSED' })
    lastError: string | null;

    @ApiPropertyOptional({
        enum: ['UNKNOWN', 'UP', 'DEGRADED', 'DOWN', 'PAUSED'],
        example: 'UP',
        description: 'Status of the most recent notification',
    })
    lastNotifiedStatus: string | null;

    @ApiPropertyOptional({ example: '2026-04-05T12:00:00.000Z' })
    sslExpiresAt: Date | null;

    @ApiPropertyOptional({ example: 28 })
    sslDaysRemaining: number | null;

    @ApiPropertyOptional({ example: 'Let’s Encrypt' })
    sslIssuer: string | null;

    @ApiPropertyOptional({ example: 'api.example.com' })
    sslSubject: string | null;

    @ApiPropertyOptional({ example: '2026-03-05T12:00:00.000Z' })
    sslLastNotifiedAt: Date | null;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    createdAt: Date;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    updatedAt: Date;

    @Exclude()
    deletedAt: Date | null;

    constructor(partial: Partial<MonitorEntity>) {
        Object.assign(this, partial);
    }
}
