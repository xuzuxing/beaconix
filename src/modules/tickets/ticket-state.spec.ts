import { ConflictException } from '@nestjs/common';
import {
    assertTransition,
    canTransition,
    statusTimestamps,
} from './ticket-state';
import type { TicketStatus } from '../../generated/prisma/enums';

const STATUSES: TicketStatus[] = ['OPEN', 'PROCESSING', 'RESOLVED', 'CLOSED'];

/** Every permitted move, plus the idempotent same-state moves. */
const ALLOWED = new Set([
    'OPEN>OPEN',
    'OPEN>PROCESSING',
    'OPEN>RESOLVED',
    'OPEN>CLOSED',
    'PROCESSING>PROCESSING',
    'PROCESSING>OPEN',
    'PROCESSING>RESOLVED',
    'PROCESSING>CLOSED',
    'RESOLVED>RESOLVED',
    'RESOLVED>OPEN',
    'RESOLVED>CLOSED',
    'CLOSED>CLOSED',
    'CLOSED>OPEN',
]);

describe('ticket-state', () => {
    it.each(
        STATUSES.flatMap((from) =>
            STATUSES.map((to) => [from, to] as [TicketStatus, TicketStatus]),
        ),
    )('%s -> %s matches the documented state machine', (from, to) => {
        const allowed = ALLOWED.has(`${from}>${to}`);

        expect(canTransition(from, to)).toBe(allowed);
        if (allowed) {
            expect(() => assertTransition(from, to)).not.toThrow();
        } else {
            expect(() => assertTransition(from, to)).toThrow(ConflictException);
        }
    });

    it('reports the failing transition in the conflict payload', () => {
        try {
            assertTransition('CLOSED', 'PROCESSING');
            throw new Error('expected assertTransition to throw');
        } catch (error) {
            expect(error).toBeInstanceOf(ConflictException);
            expect((error as ConflictException).getResponse()).toEqual({
                code: 'INVALID_TICKET_TRANSITION',
                message: 'Cannot move ticket from CLOSED to PROCESSING',
            });
        }
    });

    it('stamps the timestamp columns for the target status', () => {
        const now = new Date('2026-10-17T08:00:00.000Z');

        expect(statusTimestamps('RESOLVED', now)).toEqual({
            resolvedAt: now,
            closedAt: null,
        });
        expect(statusTimestamps('CLOSED', now)).toEqual({ closedAt: now });
        expect(statusTimestamps('OPEN', now)).toEqual({
            resolvedAt: null,
            closedAt: null,
        });
        expect(statusTimestamps('PROCESSING', now)).toEqual({
            resolvedAt: null,
            closedAt: null,
        });
    });
});
