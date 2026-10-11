import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MonitorType } from '../../../generated/prisma/enums';

export class MonitorStateEntity {
    @ApiProperty({ example: 'uuid-monitor' })
    monitorId: string;

    @ApiProperty({ example: 'Production API' })
    name: string;

    @ApiProperty({ example: 'https://api.example.com/health' })
    target: string;

    @ApiProperty({ enum: MonitorType, example: 'HTTP' })
    type: string;

    @ApiPropertyOptional({
        example: 'PING executable or ICMP permission unavailable',
    })
    executionBlockedReason: string | null;

    @ApiProperty({
        enum: ['UNKNOWN', 'UP', 'DEGRADED', 'DOWN', 'PAUSED'],
        example: 'UP',
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

    @ApiPropertyOptional({ example: '2026-03-05T12:00:00.000Z' })
    updatedAt: Date | null;

    @ApiPropertyOptional({
        example: 99.5,
        description: 'Uptime percentage over the trailing 24 hours',
    })
    uptimePercent: number | null;

    @ApiPropertyOptional({
        example: 128,
        description: 'Average latency in ms over the trailing 24 hours',
    })
    avgLatency: number | null;

    constructor(partial: Partial<MonitorStateEntity>) {
        Object.assign(this, partial);
    }
}
