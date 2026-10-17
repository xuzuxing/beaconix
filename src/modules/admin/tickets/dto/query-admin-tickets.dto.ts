import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsBoolean,
    IsEnum,
    IsInt,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { IsCuid } from '../../../../common/decorators/is-cuid.decorator';
import {
    TicketPriority,
    TicketStatus,
} from '../../../../generated/prisma/enums';

export class QueryAdminTicketsDto {
    @ApiPropertyOptional({ enum: TicketStatus, example: 'OPEN' })
    @IsOptional()
    @IsEnum(TicketStatus)
    status?: TicketStatus;

    @ApiPropertyOptional({ enum: TicketPriority, example: 'HIGH' })
    @IsOptional()
    @IsEnum(TicketPriority)
    priority?: TicketPriority;

    @ApiPropertyOptional({ example: 'cmgu92m5x0002p8l4h8z6s3k3' })
    @IsOptional()
    @IsCuid()
    categoryId?: string;

    @ApiPropertyOptional({ example: 'cmgu92m5x0000p8l4h8z6s3k1' })
    @IsOptional()
    @IsCuid()
    assigneeId?: string;

    @ApiPropertyOptional({
        description: 'Only tickets without an assignee',
        example: true,
    })
    @IsOptional()
    @Transform(({ value }) => value === 'true' || value === true)
    @IsBoolean()
    unassigned?: boolean;

    @ApiPropertyOptional({
        description: 'Fuzzy match on subject, content or author email',
        example: 'export',
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    q?: string;

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
