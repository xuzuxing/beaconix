import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
    TicketActivityType,
    TicketAuthorType,
} from '../../../generated/prisma/enums';
import { TicketUserSummaryEntity } from './ticket.entity';

/**
 * One entry of the merged ticket timeline.
 *
 * The shape is a discriminated union on `kind`: reply items carry `body` and
 * `isInternalNote`, activity items carry `type` / `field` / `oldValue` /
 * `newValue` / `meta`. Swagger cannot express the union, so every field is
 * declared optional and documented by `kind`.
 */
export class TicketTimelineItemEntity {
    @ApiProperty({ enum: ['reply', 'activity'], example: 'reply' })
    kind: 'reply' | 'activity';

    @ApiProperty()
    id: string;

    @ApiProperty({
        enum: ['USER', 'STAFF'],
        example: 'USER',
        description: 'Author type for replies, actor type for activities',
    })
    authorType: TicketAuthorType;

    @ApiPropertyOptional({ type: TicketUserSummaryEntity, nullable: true })
    author?: TicketUserSummaryEntity | null;

    @ApiPropertyOptional({
        description: 'Reply body (kind = reply)',
        example: 'This still happens after the latest deploy.',
    })
    body?: string;

    @ApiPropertyOptional({
        description:
            'Internal note flag (kind = reply); always false user-side',
    })
    isInternalNote?: boolean;

    @ApiPropertyOptional({
        enum: [
            'CREATED',
            'STATUS_CHANGED',
            'PRIORITY_CHANGED',
            'CATEGORY_CHANGED',
            'ASSIGNED',
            'UNASSIGNED',
        ],
        description: 'Activity type (kind = activity)',
    })
    type?: TicketActivityType;

    @ApiPropertyOptional({
        example: 'status',
        description: 'Changed field (kind = activity)',
    })
    field?: string | null;

    @ApiPropertyOptional({ example: 'OPEN' })
    oldValue?: string | null;

    @ApiPropertyOptional({ example: 'PROCESSING' })
    newValue?: string | null;

    @ApiPropertyOptional({
        example: { categoryName: 'Billing' },
        description: 'Snapshot data so renames do not rewrite history',
    })
    meta?: Record<string, unknown>;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    createdAt: Date;
}
