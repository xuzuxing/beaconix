import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { TicketAttachmentsDto } from './attachment-ref.dto';

export class CreateTicketReplyDto extends TicketAttachmentsDto {
    @ApiProperty({ example: 'This still happens after the latest deploy.' })
    @IsString()
    @MinLength(1)
    @MaxLength(5000)
    body: string;
}
