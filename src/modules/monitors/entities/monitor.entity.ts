import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';

export class MonitorEntity {
    @ApiProperty({ example: 'uuid-here' })
    id: string;

    @ApiProperty({ example: 'uuid-org' })
    organizationId: string;

    @ApiProperty({ example: 'uuid-project' })
    projectId: string;

    @ApiProperty({ example: 'Production API' })
    name: string;

    @ApiProperty({ enum: ['HTTP', 'TCP'], example: 'HTTP' })
    type: string;

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

    @ApiProperty({ example: true })
    enabled: boolean;

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
