import { ApiProperty } from '@nestjs/swagger';
import type { TicketAttachmentRef } from '../../attachments/attachment-limits';

/**
 * One attachment as the client sees it: `url` is already a usable link
 * (`/api/attachments/object?…&exp=…&sig=…` for LOCAL storage), so a browser can
 * render it directly.
 */
export class TicketAttachmentEntity implements TicketAttachmentRef {
    @ApiProperty({ example: 'error.log' })
    filename: string;

    @ApiProperty({ example: 'text/plain' })
    mimeType: string;

    @ApiProperty({ example: 20480, description: 'Size in bytes' })
    size: number;

    @ApiProperty({
        example: '/api/attachments/object?key=tickets/2026/10/error.log',
    })
    url: string;

    @ApiProperty({ example: 'tickets/2026/10/error.log' })
    fileKey: string;

    constructor(partial: Partial<TicketAttachmentEntity>) {
        Object.assign(this, partial);
    }
}
