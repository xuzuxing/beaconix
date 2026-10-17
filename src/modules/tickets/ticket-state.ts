import { ConflictException } from '@nestjs/common';
import { TicketStatus } from '../../generated/prisma/enums';

/**
 * Allowed status transitions for a platform ticket.
 *
 * `OPEN` is the only state a reopened ticket can return to, and `CLOSED` is
 * reachable from every state so a user can always confirm resolution.
 */
const ALLOWED: Record<TicketStatus, readonly TicketStatus[]> = {
    OPEN: ['PROCESSING', 'RESOLVED', 'CLOSED'],
    PROCESSING: ['OPEN', 'RESOLVED', 'CLOSED'],
    RESOLVED: ['OPEN', 'CLOSED'],
    CLOSED: ['OPEN'],
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
    if (from === to) return true;
    return ALLOWED[from]?.includes(to) ?? false;
}

/**
 * Throws `409 INVALID_TICKET_TRANSITION` when the move is not allowed.
 * Same-state moves are idempotent no-ops.
 */
export function assertTransition(from: TicketStatus, to: TicketStatus): void {
    if (canTransition(from, to)) return;
    throw new ConflictException({
        code: 'INVALID_TICKET_TRANSITION',
        message: `Cannot move ticket from ${from} to ${to}`,
    });
}

/**
 * Timestamp columns to stamp (or clear) when a ticket enters `status`.
 * Reopening clears both resolution markers so the next cycle starts clean.
 */
export function statusTimestamps(
    status: TicketStatus,
    now: Date = new Date(),
): {
    resolvedAt?: Date | null;
    closedAt?: Date | null;
} {
    switch (status) {
        case 'RESOLVED':
            return { resolvedAt: now, closedAt: null };
        case 'CLOSED':
            return { closedAt: now };
        case 'OPEN':
        case 'PROCESSING':
            return { resolvedAt: null, closedAt: null };
        default:
            return {};
    }
}
