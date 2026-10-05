import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProbeExecutionEntity {
    @ApiProperty({ example: 'uuid-execution' })
    id: string;

    @ApiPropertyOptional({ example: 'uuid-probe' })
    probeId: string | null;

    @ApiPropertyOptional({ example: 'uuid-monitor' })
    monitorId: string | null;

    @ApiProperty({ example: 'https://api.example.com/health' })
    target: string;

    @ApiProperty({
        enum: ['SCHEDULED', 'MANUAL', 'CALLBACK'],
        example: 'CALLBACK',
    })
    trigger: string;

    @ApiProperty({
        enum: ['SUCCESS', 'FAILED', 'TIMEOUT', 'SKIPPED'],
        example: 'SUCCESS',
    })
    status: string;

    @ApiProperty({ example: true })
    success: boolean;

    @ApiPropertyOptional({ example: 128 })
    latency: number | null;

    @ApiPropertyOptional({ example: 'connect ECONNREFUSED' })
    error: string | null;

    @ApiPropertyOptional({
        example: { accepted: 2 },
        description: 'Non-sensitive request metadata',
    })
    requestMeta: unknown;

    @ApiPropertyOptional({
        example: { applied: 1 },
        description: 'Non-sensitive response metadata',
    })
    responseMeta: unknown;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    executedAt: Date;

    constructor(partial: Partial<ProbeExecutionEntity>) {
        Object.assign(this, partial);
    }
}
