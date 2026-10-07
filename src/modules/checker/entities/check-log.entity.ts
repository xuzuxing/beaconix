import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CheckSource } from '../../../generated/prisma/enums';

export class CheckLogEntity {
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
