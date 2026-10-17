import {
    excerpt,
    notifyTicketAssigned,
    notifyTicketCreated,
    notifyTicketReply,
    notifyTicketStatusChanged,
    staffRecipients,
    ticketUrl,
} from './ticket-notifications';
import type { TicketNotificationTicket } from './ticket-notifications';
import type { NotificationDb } from '../notifications/notification-event';
import type { NotificationsService } from '../notifications/notifications.service';

const ticket: TicketNotificationTicket = {
    id: 'ticket-1',
    number: 1024,
    subject: 'Export fails on large workspaces',
    status: 'OPEN',
    priority: 'MEDIUM',
    authorId: 'author-1',
    assigneeId: null,
};

const staffRows = [{ id: 'staff-1' }, { id: 'staff-2' }];
const userRows = [
    { id: 'author-1', name: 'Ada', email: 'ada@example.com' },
    { id: 'staff-1', name: 'Ops', email: 'ops@example.com' },
];

function createContext() {
    const findMany = jest.fn(({ where }: any) =>
        Promise.resolve(
            where?.globalRole === 'SUPER_ADMIN' ? staffRows : userRows,
        ),
    );
    const db = { user: { findMany } } as unknown as NotificationDb;
    const notifications = {
        publish: jest.fn().mockResolvedValue(undefined),
        enqueueEmail: jest.fn().mockResolvedValue(undefined),
    };

    return {
        db,
        findMany,
        notifications,
        ctx: {
            db,
            notifications: notifications as unknown as NotificationsService,
            webUrl: 'https://beacon.example.com/',
        },
    };
}

describe('staffRecipients', () => {
    it('resolves only active, non-deleted platform operators', async () => {
        const { findMany, db } = createContext();

        await expect(staffRecipients(db)).resolves.toEqual([
            'staff-1',
            'staff-2',
        ]);
        expect(findMany).toHaveBeenCalledWith({
            where: {
                globalRole: 'SUPER_ADMIN',
                isActive: true,
                deletedAt: null,
            },
            select: { id: true },
        });
    });
});

describe('excerpt', () => {
    it('truncates long bodies for the inbox', () => {
        expect(excerpt('short')).toBe('short');
        expect(excerpt('x'.repeat(200))).toHaveLength(200);
        expect(excerpt('x'.repeat(201))).toHaveLength(201);
        expect(excerpt('x'.repeat(201)).endsWith('…')).toBe(true);
    });
});

describe('notifyTicketCreated', () => {
    it('notifies every operator inside the ACCOUNT scope without email', async () => {
        const { ctx, notifications } = createContext();

        await notifyTicketCreated(ctx, { ticket, actorId: 'author-1' });

        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                eventKey: 'ticket:ticket-1:created',
                type: 'TICKET_CREATED',
                recipients: ['staff-1', 'staff-2'],
                actorId: 'author-1',
                accessScope: 'ACCOUNT',
                resourceType: 'Ticket',
                resourceId: 'ticket-1',
                meta: {
                    ticketNumber: 1024,
                    subject: ticket.subject,
                    status: 'OPEN',
                    priority: 'MEDIUM',
                },
            }),
            ctx.db,
        );
        expect(notifications.publish.mock.calls[0][0]).not.toHaveProperty(
            'organizationId',
        );
        expect(notifications.enqueueEmail).not.toHaveBeenCalled();
    });

    it('does nothing when the platform has no operator yet', async () => {
        const { ctx, notifications, findMany } = createContext();
        findMany.mockResolvedValueOnce([]);

        await notifyTicketCreated(ctx, { ticket, actorId: 'author-1' });

        expect(notifications.publish).not.toHaveBeenCalled();
    });
});

describe('notifyTicketReply', () => {
    it('never notifies for an internal note', async () => {
        const { ctx, notifications, findMany } = createContext();

        await notifyTicketReply(ctx, {
            ticket,
            actorId: 'staff-1',
            actorType: 'STAFF',
            replyId: 'reply-1',
            body: 'internal',
            isInternalNote: true,
        });

        expect(findMany).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
        expect(notifications.enqueueEmail).not.toHaveBeenCalled();
    });

    it('emails the author when staff replies publicly', async () => {
        const { ctx, notifications } = createContext();

        await notifyTicketReply(ctx, {
            ticket: { ...ticket, assigneeId: 'staff-2' },
            actorId: 'staff-2',
            actorType: 'STAFF',
            replyId: 'reply-1',
            body: 'We are looking into it',
        });

        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                eventKey: 'ticket:ticket-1:reply:reply-1',
                type: 'TICKET_REPLIED',
                recipients: ['author-1'],
                body: 'We are looking into it',
            }),
            ctx.db,
        );
        expect(notifications.enqueueEmail).toHaveBeenCalledWith(
            'ticket-replied',
            {
                to: 'ada@example.com',
                name: 'Ada',
                ticketNumber: 1024,
                subject: ticket.subject,
                body: 'We are looking into it',
                ticketUrl: 'https://beacon.example.com/tickets/ticket-1',
            },
            'ticket:ticket-1:reply:reply-1:email:author-1',
            ctx.db,
            {
                accessScope: 'ACCOUNT',
                userId: 'author-1',
                email: 'ada@example.com',
            },
        );
    });

    it('routes a user reply to the assignee and emails them', async () => {
        const { ctx, notifications } = createContext();

        await notifyTicketReply(ctx, {
            ticket: { ...ticket, assigneeId: 'staff-1' },
            actorId: 'author-1',
            actorType: 'USER',
            replyId: 'reply-2',
            body: 'Any update?',
        });

        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({ recipients: ['staff-1'] }),
            ctx.db,
        );
        expect(notifications.enqueueEmail).toHaveBeenCalledWith(
            'ticket-replied',
            expect.objectContaining({ to: 'ops@example.com' }),
            'ticket:ticket-1:reply:reply-2:email:staff-1',
            ctx.db,
            expect.objectContaining({ userId: 'staff-1' }),
        );
    });

    it('falls back to every operator for an unassigned ticket', async () => {
        const { ctx, notifications } = createContext();

        await notifyTicketReply(ctx, {
            ticket,
            actorId: 'author-1',
            actorType: 'USER',
            replyId: 'reply-3',
            body: 'Ping',
        });

        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({ recipients: ['staff-1', 'staff-2'] }),
            ctx.db,
        );
    });
});

describe('notifyTicketStatusChanged', () => {
    it('email only the author for RESOLVED, excluding the actor', async () => {
        const { ctx, notifications } = createContext();

        await notifyTicketStatusChanged(ctx, {
            ticket: { ...ticket, assigneeId: 'staff-1' },
            actorId: 'staff-2',
            from: 'PROCESSING',
            to: 'RESOLVED',
        });

        const event = notifications.publish.mock.calls[0][0];
        expect(event.recipients).toEqual(['author-1', 'staff-1']);
        expect(event.eventKey).toMatch(/^ticket:ticket-1:status:/);
        expect(notifications.enqueueEmail).toHaveBeenCalledTimes(1);
        expect(notifications.enqueueEmail).toHaveBeenCalledWith(
            'ticket-status-changed',
            expect.objectContaining({
                to: 'ada@example.com',
                status: 'RESOLVED',
            }),
            expect.stringContaining(':email:author-1'),
            ctx.db,
            expect.objectContaining({ userId: 'author-1' }),
        );
    });

    it('notifies operators but never emails when the author closes their own ticket', async () => {
        const { ctx, notifications } = createContext();

        await notifyTicketStatusChanged(ctx, {
            ticket,
            actorId: 'author-1',
            from: 'RESOLVED',
            to: 'CLOSED',
        });

        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({ recipients: ['staff-1', 'staff-2'] }),
            ctx.db,
        );
        expect(notifications.enqueueEmail).not.toHaveBeenCalled();
    });

    it('falls back to operators when a terminal ticket has no audience left', async () => {
        const { ctx, notifications } = createContext();

        await notifyTicketStatusChanged(ctx, {
            ticket: { ...ticket, assigneeId: 'staff-1' },
            actorId: 'author-1',
            from: 'OPEN',
            to: 'CLOSED',
        });

        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({ recipients: ['staff-1'] }),
            ctx.db,
        );
        expect(notifications.enqueueEmail).not.toHaveBeenCalled();
    });

    it('does not notify a no-op transition', async () => {
        const { ctx, notifications } = createContext();

        await notifyTicketStatusChanged(ctx, {
            ticket,
            actorId: 'staff-1',
            from: 'OPEN',
            to: 'OPEN',
        });

        expect(notifications.publish).not.toHaveBeenCalled();
    });
});

describe('notifyTicketAssigned', () => {
    it('notifies the new assignee with a random-suffixed key', async () => {
        const { ctx, notifications } = createContext();

        await notifyTicketAssigned(ctx, {
            ticket,
            actorId: 'staff-2',
            assigneeId: 'staff-1',
        });

        const event = notifications.publish.mock.calls[0][0];
        expect(event).toMatchObject({
            type: 'TICKET_ASSIGNED',
            recipients: ['staff-1'],
            actorId: 'staff-2',
        });
        expect(event.eventKey).toMatch(
            /^ticket:ticket-1:assignee:staff-1:[0-9a-f-]{36}$/,
        );
        expect(notifications.enqueueEmail).not.toHaveBeenCalled();
    });

    it('stays silent when someone assigns the ticket to themselves', async () => {
        const { ctx, notifications } = createContext();

        await notifyTicketAssigned(ctx, {
            ticket,
            actorId: 'staff-1',
            assigneeId: 'staff-1',
        });

        expect(notifications.publish).not.toHaveBeenCalled();
    });
});

describe('ticketUrl', () => {
    it('strips trailing slashes from the web base URL', () => {
        expect(ticketUrl('https://beacon.example.com///', 'ticket-1')).toBe(
            'https://beacon.example.com/tickets/ticket-1',
        );
    });
});
