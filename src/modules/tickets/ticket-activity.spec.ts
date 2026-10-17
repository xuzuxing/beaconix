import {
    assigneeChangedActivity,
    categoryChangedActivity,
    createdActivity,
    mergeTimeline,
    priorityChangedActivity,
    recordActivity,
    statusChangedActivity,
} from './ticket-activity';
import type {
    TicketActivityRow,
    TicketActivityDb,
    TicketReplyRow,
} from './ticket-activity';

const at = (iso: string) => new Date(iso);

describe('ticket-activity constructors', () => {
    it('records creation as a CREATED event', () => {
        expect(createdActivity('ticket-1', 'user-1')).toEqual({
            ticketId: 'ticket-1',
            actorId: 'user-1',
            actorType: 'USER',
            type: 'CREATED',
        });
    });

    it('records staff-driven creation as STAFF actor', () => {
        expect(createdActivity('ticket-1', 'staff-1', 'STAFF')).toMatchObject({
            actorType: 'STAFF',
        });
    });

    it('skips events whose value did not actually change', () => {
        expect(
            statusChangedActivity({
                ticketId: 'ticket-1',
                actorId: 'staff-1',
                actorType: 'STAFF',
                from: 'OPEN',
                to: 'OPEN',
            }),
        ).toBeNull();
        expect(
            priorityChangedActivity({
                ticketId: 'ticket-1',
                actorId: 'staff-1',
                actorType: 'STAFF',
                from: 'HIGH',
                to: 'HIGH',
            }),
        ).toBeNull();
        expect(
            categoryChangedActivity({
                ticketId: 'ticket-1',
                actorId: 'staff-1',
                actorType: 'STAFF',
                from: 'cat-1',
                to: 'cat-1',
                categoryName: 'Billing',
            }),
        ).toBeNull();
        expect(
            assigneeChangedActivity({
                ticketId: 'ticket-1',
                actorId: 'staff-1',
                actorType: 'STAFF',
                from: null,
                to: null,
                assigneeName: null,
            }),
        ).toBeNull();
    });

    it('records status and priority changes with old/new values', () => {
        expect(
            statusChangedActivity({
                ticketId: 'ticket-1',
                actorId: 'staff-1',
                actorType: 'STAFF',
                from: 'OPEN',
                to: 'PROCESSING',
            }),
        ).toEqual({
            ticketId: 'ticket-1',
            actorId: 'staff-1',
            actorType: 'STAFF',
            type: 'STATUS_CHANGED',
            field: 'status',
            oldValue: 'OPEN',
            newValue: 'PROCESSING',
        });

        expect(
            priorityChangedActivity({
                ticketId: 'ticket-1',
                actorId: 'staff-1',
                actorType: 'STAFF',
                from: 'MEDIUM',
                to: 'CRITICAL',
            }),
        ).toMatchObject({
            type: 'PRIORITY_CHANGED',
            field: 'priority',
            oldValue: 'MEDIUM',
            newValue: 'CRITICAL',
        });
    });

    it('snapshots the category name so renames do not rewrite history', () => {
        expect(
            categoryChangedActivity({
                ticketId: 'ticket-1',
                actorId: 'staff-1',
                actorType: 'STAFF',
                from: null,
                to: 'cat-2',
                categoryName: 'Billing',
            }),
        ).toMatchObject({
            type: 'CATEGORY_CHANGED',
            field: 'categoryId',
            oldValue: null,
            newValue: 'cat-2',
            meta: { categoryName: 'Billing' },
        });
    });

    it('switches between ASSIGNED and UNASSIGNED', () => {
        expect(
            assigneeChangedActivity({
                ticketId: 'ticket-1',
                actorId: 'staff-1',
                actorType: 'STAFF',
                from: null,
                to: 'staff-2',
                assigneeName: 'Ops',
            }),
        ).toMatchObject({
            type: 'ASSIGNED',
            oldValue: null,
            newValue: 'staff-2',
            meta: { assigneeName: 'Ops' },
        });

        expect(
            assigneeChangedActivity({
                ticketId: 'ticket-1',
                actorId: 'staff-1',
                actorType: 'STAFF',
                from: 'staff-2',
                to: null,
                assigneeName: null,
            }),
        ).toMatchObject({
            type: 'UNASSIGNED',
            oldValue: 'staff-2',
            newValue: null,
            meta: { assigneeName: null },
        });
    });
});

describe('recordActivity', () => {
    it('writes the event through the ticketActivity delegate', async () => {
        const create = jest.fn().mockResolvedValue({});
        const db = {
            ticketActivity: { create },
        } as unknown as TicketActivityDb;

        await recordActivity(db, {
            ticketId: 'ticket-1',
            actorId: 'staff-1',
            actorType: 'STAFF',
            type: 'STATUS_CHANGED',
            field: 'status',
            oldValue: 'OPEN',
            newValue: 'PROCESSING',
        });

        expect(create).toHaveBeenCalledWith({
            data: {
                ticketId: 'ticket-1',
                actorId: 'staff-1',
                actorType: 'STAFF',
                type: 'STATUS_CHANGED',
                field: 'status',
                oldValue: 'OPEN',
                newValue: 'PROCESSING',
                meta: {},
            },
        });
    });
});

describe('mergeTimeline', () => {
    const author = { id: 'user-1', name: 'Ada', avatarUrl: null };

    const reply = (over: Partial<TicketReplyRow>): TicketReplyRow => ({
        id: 'reply-1',
        authorType: 'USER',
        body: 'hello',
        isInternalNote: false,
        createdAt: at('2026-10-17T08:00:00.000Z'),
        author,
        ...over,
    });

    const activity = (over: Partial<TicketActivityRow>): TicketActivityRow => ({
        id: 'activity-1',
        actorType: 'USER',
        type: 'CREATED',
        field: null,
        oldValue: null,
        newValue: null,
        meta: {},
        createdAt: at('2026-10-17T08:00:00.000Z'),
        actor: author,
        ...over,
    });

    it('merges both sources in ascending time order', () => {
        const merged = mergeTimeline(
            [reply({ id: 'r2', createdAt: at('2026-10-17T08:02:00.000Z') })],
            [activity({ createdAt: at('2026-10-17T08:01:00.000Z') })],
        );

        expect(merged.map((item) => item.kind)).toEqual(['activity', 'reply']);
    });

    it('puts a reply before an activity sharing the same timestamp', () => {
        const merged = mergeTimeline(
            [reply({ id: 'z-reply' })],
            [activity({ id: 'a-activity' })],
        );

        expect(merged.map((item) => item.id)).toEqual([
            'z-reply',
            'a-activity',
        ]);
    });

    it('breaks remaining ties by id', () => {
        const merged = mergeTimeline(
            [reply({ id: 'reply-b' }), reply({ id: 'reply-a' })],
            [],
        );

        expect(merged.map((item) => item.id)).toEqual(['reply-a', 'reply-b']);
    });

    it('normalises non-object meta to an empty record', () => {
        const merged = mergeTimeline(
            [],
            [activity({ meta: null }), activity({ id: 'a2', meta: [] })],
        );

        for (const item of merged) {
            if (item.kind === 'activity') expect(item.meta).toEqual({});
        }
    });
});
