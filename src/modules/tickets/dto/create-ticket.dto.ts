import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsEnum,
    IsOptional,
    IsString,
    MaxLength,
    MinLength,
} from 'class-validator';
import { IsCuid } from '../../../common/decorators/is-cuid.decorator';
import { TicketPriority } from '../../../generated/prisma/enums';

export class CreateTicketDto {
    @ApiProperty({ example: 'Export fails on large workspaces' })
    @IsString()
    @MinLength(4)
    @MaxLength(200)
    subject: string;

    @ApiProperty({
        example:
            'Posting the export endpoint returns 500 when the project has more than 10k tasks.',
    })
    @IsString()
    @MinLength(1)
    @MaxLength(5000)
    content: string;

    @ApiPropertyOptional({ enum: TicketPriority, example: 'MEDIUM' })
    @IsOptional()
    @IsEnum(TicketPriority)
    priority?: TicketPriority;

    @ApiPropertyOptional({ example: 'cmgu92m5x0002p8l4h8z6s3k3' })
    @IsOptional()
    @IsCuid()
    categoryId?: string;
}
