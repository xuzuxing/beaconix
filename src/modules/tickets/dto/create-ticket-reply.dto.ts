import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateTicketReplyDto {
    @ApiProperty({ example: 'This still happens after the latest deploy.' })
    @IsString()
    @MinLength(1)
    @MaxLength(5000)
    body: string;
}
