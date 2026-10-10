import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

export class CreateTaskDto {
    @ApiProperty({ example: 'Implement login page', description: 'Task title' })
    @IsString()
    @MinLength(1)
    @MaxLength(255)
    title: string;

    @ApiPropertyOptional({
        example: 'Build the login page with email and password fields',
        description: 'Task description',
    })
    @IsOptional()
    @IsString()
    @MaxLength(5000)
    description?: string;

    @ApiPropertyOptional({
        enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
        default: 'MEDIUM',
        description: 'Task priority',
    })
    @IsOptional()
    @IsEnum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], {
        message: 'Priority must be LOW, MEDIUM, HIGH, or CRITICAL',
    })
    priority?: string;

    @ApiPropertyOptional({
        example: 5,
        description: 'Story points estimation (Fibonacci recommended)',
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    storyPoints?: number;

    @ApiPropertyOptional({
        example: '2026-03-15T00:00:00.000Z',
        description: 'Due date (ISO 8601)',
    })
    @IsOptional()
    @IsDateString()
    dueDate?: string;

    @ApiPropertyOptional({
        example: 'cmgu92m5x0000p8l4h8z6s3k1',
        description: 'Sprint CUID; omit to add to backlog',
    })
    @IsOptional()
    @IsCuid()
    sprintId?: string;

    @ApiPropertyOptional({
        example: 'cmgu92m5x0001p8l4h8z6s3k2',
        description: 'Parent task CUID for subtask hierarchy',
    })
    @IsOptional()
    @IsCuid()
    parentTaskId?: string;

    @ApiPropertyOptional({
        example: 'cmgu92m5x0002p8l4h8z6s3k3',
        description: 'User CUID to assign',
    })
    @IsOptional()
    @IsCuid()
    assignedToId?: string;
}
