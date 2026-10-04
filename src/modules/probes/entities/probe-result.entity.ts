import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProbeResultEntity {
    @ApiProperty({ example: 'uuid-result' })
    id: string;

    @ApiProperty({ example: 'uuid-probe' })
    probeId: string;

    @ApiProperty({ example: 'https://api.example.com/health' })
    target: string;

    @ApiProperty({ example: true })
    success: boolean;

    @ApiPropertyOptional({ example: 'connect ECONNREFUSED' })
    error: string | null;

    @ApiProperty({ example: 128, description: 'Round-trip time in ms' })
    latency: number;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    checkedAt: Date;

    constructor(partial: Partial<ProbeResultEntity>) {
        Object.assign(this, partial);
    }
}
