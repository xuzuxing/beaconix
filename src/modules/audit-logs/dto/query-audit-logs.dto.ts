import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsOptional,
    IsEnum,
    IsString,
    IsDateString,
    IsInt,
    Min,
    Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AuditAction } from '../../../generated/prisma/enums';
import { IsCuid } from '../../../common/decorators/is-cuid.decorator';

export class QueryAuditLogsDto {
    @ApiPropertyOptional({ description: 'Filter by actor (user) ID' })
    @IsOptional()
    @IsCuid()
    actorId?: string;

    @ApiPropertyOptional({ description: 'Filter by organization ID' })
    @IsOptional()
    @IsCuid()
    organizationId?: string;

    @ApiPropertyOptional({ description: 'Filter by project ID' })
    @IsOptional()
    @IsCuid()
    projectId?: string;

    @ApiPropertyOptional({
        enum: AuditAction,
        description: 'Filter by action type',
    })
    @IsOptional()
    @IsEnum(AuditAction)
    action?: AuditAction;

    @ApiPropertyOptional({
        description: 'Filter by entity name (e.g. "Task", "Project")',
    })
    @IsOptional()
    @IsString()
    entity?: string;

    @ApiPropertyOptional({ description: 'Filter by entity ID' })
    @IsOptional()
    @IsCuid()
    entityId?: string;

    @ApiPropertyOptional({
        description: 'Start date (ISO 8601)',
        example: '2026-01-01T00:00:00.000Z',
    })
    @IsOptional()
    @IsDateString()
    from?: string;

    @ApiPropertyOptional({
        description: 'End date (ISO 8601)',
        example: '2026-12-31T23:59:59.999Z',
    })
    @IsOptional()
    @IsDateString()
    to?: string;

    @ApiPropertyOptional({ default: 1, minimum: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number = 1;

    @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    limit?: number = 25;
}
