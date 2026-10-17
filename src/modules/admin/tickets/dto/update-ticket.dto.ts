import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsBoolean,
    IsEnum,
    IsOptional,
    IsString,
    MaxLength,
    MinLength,
} from 'class-validator';
import { IsCuid } from '../../../../common/decorators/is-cuid.decorator';
import {
    TicketPriority,
    TicketStatus,
} from '../../../../generated/prisma/enums';

export class UpdateTicketDto {
    @ApiPropertyOptional({ enum: TicketPriority, example: 'HIGH' })
    @IsOptional()
    @IsEnum(TicketPriority)
    priority?: TicketPriority;

    @ApiPropertyOptional({
        enum: TicketStatus,
        example: 'PROCESSING',
        description: 'Validated against the ticket state machine',
    })
    @IsOptional()
    @IsEnum(TicketStatus)
    status?: TicketStatus;

    @ApiPropertyOptional({
        example: 'cmgu92m5x0002p8l4h8z6s3k3',
        nullable: true,
        description: 'Explicit `null` clears the category',
    })
    @IsOptional()
    @IsCuid()
    categoryId?: string | null;

    @ApiPropertyOptional({
        example: 'cmgu92m5x0000p8l4h8z6s3k1',
        nullable: true,
        description: 'Explicit `null` unassigns the ticket',
    })
    @IsOptional()
    @IsCuid()
    assigneeId?: string | null;
}

export class AdminTicketReplyDto {
    @ApiProperty({ example: 'We shipped a fix in today release.' })
    @IsString()
    @MinLength(1)
    @MaxLength(5000)
    body: string;

    @ApiPropertyOptional({
        example: false,
        description: 'Internal notes are never exposed to the submitter',
    })
    @IsOptional()
    @IsBoolean()
    isInternalNote?: boolean;
}
