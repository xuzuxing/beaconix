import { extname } from 'node:path';

/**
 * Limits shared by the ticket attachment flow: the upload endpoint, the ticket
 * DTOs and the claim step all read from here so the three never drift.
 *
 * `.log` files reach the server as `application/octet-stream` (or with an empty
 * type) depending on the client, so for logs the extension is what decides
 * whether the file is acceptable.
 */
export const TICKET_ATTACHMENT_MIME_TYPES = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'application/pdf',
    'text/plain',
] as const;

/** Log-like extensions accepted when the client cannot name a real MIME type. */
export const TICKET_LOG_EXTENSIONS = ['.log', '.txt'] as const;

/** Anything that may stand in for "I do not know this file's type". */
const UNKNOWN_MIME_TYPES = ['', 'application/octet-stream'];

export const MAX_TICKET_ATTACHMENT_SIZE = 5 * 1024 * 1024;

export const MAX_TICKET_ATTACHMENTS = 5;

/**
 * What the client sends back after uploading. Only these five fields travel in
 * the request; `directory` / `bucket` / `checksum` stay server-side.
 */
export interface TicketAttachmentRef {
    filename: string;
    mimeType: string;
    size: number;
    url: string;
    fileKey: string;
}

/** The storage directory ticket uploads are filed under. */
export const TICKET_UPLOAD_DIRECTORY = 'tickets';

export function isAllowedTicketAttachment(
    mimeType: string,
    filename = '',
): boolean {
    if (
        (TICKET_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType)
    ) {
        return true;
    }
    if (!UNKNOWN_MIME_TYPES.includes(mimeType)) return false;

    const extension = extname(filename).toLowerCase();
    return (TICKET_LOG_EXTENSIONS as readonly string[]).includes(extension);
}
