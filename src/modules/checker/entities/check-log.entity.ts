import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CheckSource } from '../../../generated/prisma/enums';
import type { JsonValue } from '../../../generated/prisma/internal/prismaNamespace';

export class CheckLogEntity {
    @ApiProperty({ example: 1 })
    revision: number;

    @ApiProperty({
        example: true,
        description: 'False means blocked execution, excluded from uptime',
    })
    evaluated: boolean;

    @ApiPropertyOptional({ example: 'ASSERTION' })
    failureKind: string | null;

    @ApiProperty({
        type: 'object',
        additionalProperties: true,
        description:
            'Bounded protocol diagnostics. HTTP: byte limits and boolean assertion outcomes, never bodies/field values. Databases: fixed health operation. Docker: validated containerState/health/startedAt only. gRPC: serving. WebSocket: heartbeat. Never credentials, SQL results or full daemon responses.',
    })
    meta: JsonValue;
    @ApiProperty({ example: 'uuid-check' })
    id: string;

    @ApiProperty({ example: 'uuid-monitor' })
    monitorId: string;

    @ApiProperty({ example: true })
    success: boolean;

    @ApiPropertyOptional({
        example: true,
        description:
            'Raw local result; null when the row carries no local check (probe report path)',
    })
    localSuccess: boolean | null;

    @ApiProperty({
        example: false,
        description:
            'True when a failing local check was rescued by a successful probe',
    })
    rescuedByProbe: boolean;

    @ApiProperty({ example: 128, description: 'Round-trip time in ms' })
    latency: number;

    @ApiPropertyOptional({ example: 'connect ECONNREFUSED' })
    error: string | null;

    @ApiPropertyOptional({
        example: 200,
        description: 'Actual HTTP status code; null for TCP or no response',
    })
    statusCode: number | null;

    @ApiProperty({
        enum: CheckSource,
        example: CheckSource.LOCAL,
        description: 'Where the check ran',
    })
    source: string;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    checkedAt: Date;

    constructor(partial: Partial<CheckLogEntity>) {
        Object.assign(this, partial);
    }
}
