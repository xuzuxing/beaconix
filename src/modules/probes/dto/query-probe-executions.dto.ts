import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import {
    ExecutionStatus,
    ExecutionTrigger,
} from '../../../generated/prisma/enums';

export class QueryProbeExecutionsDto {
    @ApiPropertyOptional({
        enum: ExecutionTrigger,
        description: 'Filter by how the execution was triggered',
    })
    @IsOptional()
    @IsEnum(ExecutionTrigger)
    trigger?: ExecutionTrigger;

    @ApiPropertyOptional({
        enum: ExecutionStatus,
        description: 'Filter by execution status',
    })
    @IsOptional()
    @IsEnum(ExecutionStatus)
    status?: ExecutionStatus;

    @ApiPropertyOptional({
        description: 'Filter by monitor UUID',
        example: 'uuid-monitor',
    })
    @IsOptional()
    @IsString()
    monitorId?: string;

    @ApiPropertyOptional({
        description: 'Filter by target URL or host:port',
        example: 'https://api.example.com/health',
    })
    @IsOptional()
    @IsString()
    target?: string;

    @ApiPropertyOptional({ default: 1, minimum: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number;

    @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    limit?: number;
}
