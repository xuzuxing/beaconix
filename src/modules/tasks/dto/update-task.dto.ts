import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsString,
    IsOptional,
    MinLength,
    MaxLength,
    IsEnum,
    IsInt,
    Min,
    IsDateString,
} from 'class-validator';
import { IsCuid } from '../../../common/decorators/is-cuid.decorator';

export class UpdateTaskDto {
    @ApiPropertyOptional({ example: 'Updated task title' })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(255)
    title?: string;

    @ApiPropertyOptional({ example: 'Updated description' })
    @IsOptional()
    @IsString()
    @MaxLength(5000)
    description?: string;

    @ApiPropertyOptional({
        enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
    })
    @IsOptional()
    @IsEnum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], {
        message: 'Priority must be LOW, MEDIUM, HIGH, or CRITICAL',
    })
    priority?: string;

    @ApiPropertyOptional({
        enum: ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED'],
    })
    @IsOptional()
    @IsEnum(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED'], {
        message:
            'Status must be TODO, IN_PROGRESS, IN_REVIEW, DONE, or CANCELLED',
    })
    status?: string;

    @ApiPropertyOptional({ example: 5 })
    @IsOptional()
    @IsInt()
    @Min(0)
    storyPoints?: number;

    @ApiPropertyOptional({ example: '2026-03-15T00:00:00.000Z' })
    @IsOptional()
    @IsDateString()
    dueDate?: string;

    @ApiPropertyOptional({
        example: 'cmgu92m5x0001p8l4h8z6s3k2',
        description: 'Update parent task for subtask hierarchy (null to unset)',
    })
    @IsOptional()
    @IsCuid()
    parentTaskId?: string;
}
