import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
    TicketPriority,
    TicketStatus,
} from '../../../generated/prisma/enums';
import { TicketCategoryEntity } from './ticket-category.entity';

/** Minimal user projection shared by ticket author / assignee / actors. */
export class TicketUserSummaryEntity {
    @ApiProperty({ example: 'cmgu92m5x0000p8l4h8z6s3k1' })
    id: string;

    @ApiProperty({ example: 'Ada Lovelace' })
    name: string;

    @ApiPropertyOptional({
        example: 'https://cdn.example.com/avatars/ada.png',
        nullable: true,
    })
    avatarUrl: string | null;

    constructor(partial: Partial<TicketUserSummaryEntity>) {
        Object.assign(this, partial);
    }
}

export class TicketEntity {
    @ApiProperty({ example: 'cmgu92m5x0001p8l4h8z6s3k2' })
    id: string;

    @ApiProperty({ example: 1024, description: 'Platform-wide ticket number' })
    number: number;

    @ApiProperty({ example: 'Export fails on large workspaces' })
    subject: string;

    @ApiProperty({ example: 'Posting the export endpoint returns 500 …' })
    content: string;

    @ApiProperty({
        enum: ['OPEN', 'PROCESSING', 'RESOLVED', 'CLOSED'],
        example: 'OPEN',
    })
    status: TicketStatus;

    @ApiProperty({
        enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
        example: 'MEDIUM',
    })
    priority: TicketPriority;

    @ApiPropertyOptional({ nullable: true })
    categoryId: string | null;

    @ApiPropertyOptional({ type: TicketCategoryEntity, nullable: true })
    category?: TicketCategoryEntity | null;

    @ApiPropertyOptional({
        description:
            'Snapshot of the organization the author belonged to when submitting',
        nullable: true,
    })
    organizationId: string | null;

    @ApiProperty()
    authorId: string;

    @ApiPropertyOptional({ type: TicketUserSummaryEntity, nullable: true })
    author?: TicketUserSummaryEntity | null;

    @ApiPropertyOptional({
        description: 'Platform operator handling the ticket',
        nullable: true,
    })
    assigneeId: string | null;

    @ApiPropertyOptional({ type: TicketUserSummaryEntity, nullable: true })
    assignee?: TicketUserSummaryEntity | null;

    @ApiPropertyOptional({ nullable: true })
    firstRespondedAt: Date | null;

    @ApiPropertyOptional({ nullable: true })
    resolvedAt: Date | null;

    @ApiPropertyOptional({ nullable: true })
    closedAt: Date | null;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    createdAt: Date;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    updatedAt: Date;

    constructor(partial: Partial<TicketEntity>) {
        Object.assign(this, partial);
    }
}
