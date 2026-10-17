import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsInt,
    IsOptional,
    IsString,
    Length,
    Matches,
    Max,
    Min,
    ValidateNested,
} from 'class-validator';
import {
    MAX_TICKET_ATTACHMENT_SIZE,
    MAX_TICKET_ATTACHMENTS,
} from '../../attachments/attachment-limits';

/**
 * What the client sends back for a file it already uploaded through
 * `POST /api/attachments/upload`.
 *
 * The server re-reads the stored row by `fileKey` and takes `size`, `mimeType`
 * and `url` from there, so these fields only describe what the client thinks it
 * uploaded — they are never trusted for the stored attachment.
 */
export class AttachmentRefDto {
    @ApiProperty({ example: 'error.log' })
    @IsString()
    @Length(1, 255)
    filename: string;

    @ApiProperty({ example: 'text/plain' })
    @IsString()
    @Length(1, 255)
    mimeType: string;

    @ApiProperty({ example: 20480, description: 'Size in bytes' })
    @IsInt()
    @Min(1)
    @Max(MAX_TICKET_ATTACHMENT_SIZE)
    size: number;

    @ApiProperty({
        example: '/api/attachments/object?key=tickets/2026/10/error.log',
        description:
            'Absolute URL or a same-origin path; LOCAL storage returns a signed path',
    })
    @IsString()
    @Length(1, 1024)
    @Matches(/^(https?:\/\/|\/)/, {
        message: 'url must be absolute or start with /',
    })
    url: string;

    @ApiProperty({ example: 'tickets/2026/10/error.log' })
    @IsString()
    @Length(1, 512)
    fileKey: string;
}

/**
 * Shared `attachments` field for ticket creation and both reply endpoints.
 * Kept as a standalone class so each DTO can document it explicitly.
 */
export class TicketAttachmentsDto {
    @ApiPropertyOptional({
        type: [AttachmentRefDto],
        description: `Uploaded attachments (max ${MAX_TICKET_ATTACHMENTS})`,
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MAX_TICKET_ATTACHMENTS)
    @ValidateNested({ each: true })
    @Type(() => AttachmentRefDto)
    attachments?: AttachmentRefDto[];
}
