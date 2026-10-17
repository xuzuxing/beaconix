import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { TicketAuthorType } from '../../../generated/prisma/enums';
import { TicketUserSummaryEntity } from './ticket.entity';

export class TicketReplyEntity {
    @ApiProperty()
    id: string;

    @ApiProperty()
    ticketId: string;

    @ApiProperty()
    authorId: string;

    @ApiProperty({ enum: ['USER', 'STAFF'], example: 'USER' })
    authorType: TicketAuthorType;

    @ApiProperty({ example: 'This still happens after the latest deploy.' })
    body: string;

    @ApiProperty({
        example: false,
        description:
            'Internal platform note — never returned by the user-facing endpoints',
    })
    isInternalNote: boolean;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    createdAt: Date;

    @ApiPropertyOptional({ type: TicketUserSummaryEntity, nullable: true })
    author?: TicketUserSummaryEntity | null;

    constructor(partial: Partial<TicketReplyEntity>) {
        Object.assign(this, partial);
    }
}
