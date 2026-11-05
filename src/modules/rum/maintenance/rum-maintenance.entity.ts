import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    RumMaintenanceJobStatus,
    RumMaintenanceJobType,
} from '../../../generated/prisma/enums';

export class RumMaintenanceJobEntity {
    @ApiProperty()
    id: string;

    @ApiProperty()
    appId: string;

    @ApiProperty()
    organizationId: string;

    @ApiProperty({ enum: RumMaintenanceJobType })
    type: RumMaintenanceJobType;

    @ApiProperty({ enum: RumMaintenanceJobStatus })
    status: RumMaintenanceJobStatus;

    @ApiPropertyOptional({ type: Object, nullable: true })
    payload: unknown;

    @ApiPropertyOptional({
        type: Object,
        nullable: true,
        description:
            'Deletion counters (table → rows) for PURGE, or subject coverage counters for SUBJECT_DELETION',
    })
    result: unknown;

    @ApiPropertyOptional({ nullable: true })
    error: string | null;

    @ApiPropertyOptional({ nullable: true })
    requestedById: string | null;

    @ApiProperty()
    createdAt: Date;

    @ApiPropertyOptional({ nullable: true })
    startedAt: Date | null;

    @ApiPropertyOptional({ nullable: true })
    completedAt: Date | null;
}
