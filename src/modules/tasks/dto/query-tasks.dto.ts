import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsEnum, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { IsCuid } from '../../../common/decorators/is-cuid.decorator';

export class QueryTasksDto {
    @ApiPropertyOptional({
        enum: ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED'],
    })
    @IsOptional()
    @IsEnum(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED'])
    status?: string;

    @ApiPropertyOptional({
        enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
    })
    @IsOptional()
    @IsEnum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
    priority?: string;

    @ApiPropertyOptional({ example: 'cmgu92m5x0002p8l4h8z6s3k3' })
    @IsOptional()
    @IsCuid()
    assignedToId?: string;

    @ApiPropertyOptional({ example: 'cmgu92m5x0000p8l4h8z6s3k1' })
    @IsOptional()
    @IsCuid()
    sprintId?: string;

    @ApiPropertyOptional({ example: 'cmgu92m5x0001p8l4h8z6s3k2' })
    @IsOptional()
    @IsCuid()
    parentTaskId?: string;

    @ApiPropertyOptional({ example: 1, default: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number;

    @ApiPropertyOptional({ example: 20, default: 20 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    limit?: number;
}
