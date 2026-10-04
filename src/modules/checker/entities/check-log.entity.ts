import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CheckSource } from '../../../generated/prisma/enums';

export class CheckLogEntity {
    @ApiProperty({ example: 'uuid-check' })
    id: string;

    @ApiProperty({ example: 'uuid-monitor' })
    monitorId: string;

    @ApiProperty({ example: true })
    success: boolean;

    @ApiProperty({ example: 128, description: 'Round-trip time in ms' })
    latency: number;

    @ApiPropertyOptional({ example: 'connect ECONNREFUSED' })
    error: string | null;

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
