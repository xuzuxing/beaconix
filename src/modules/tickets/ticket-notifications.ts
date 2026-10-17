import { randomUUID } from 'node:crypto';
import { EmailTemplate } from '../email/email.types';
import type {
    NotificationDb,
    NotificationRecipient,
} from '../notifications/notification-event';
import type { NotificationsService } from '../notifications/notifications.service';
import type {
    TicketAuthorType,
    TicketPriority,
    TicketStatus,
} from '../../generated/prisma/enums';

/** Notification excerpts stop at this length; the inbox UI never shows more. */
export const NOTIFICATION_EXCERPT_LENGTH = 200;

export interface TicketNotificationTicket {
    id: string;
    number: number;
    subject: string;
    status: TicketStatus;
    priority: TicketPriority;
    authorId: string;
    assigneeId: string | null;
}

/**
 * Everything the ticket notification helpers need. Passed explicitly so these
 * helpers stay free functions (no Nest provider) and can be shared by the user
 * module and the admin module without a provider dependency between them.
 */
export interface TicketNotifyContext {
    db: NotificationDb;
    notifications: NotificationsService;
    /** Web client base URL without a trailing slash (`APP_WEB_URL`). */
    webUrl: string;
}

export function excerpt(
    text: string,
    limit: number = NOTIFICATION_EXCERPT_LENGTH,
): string {
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}…`;
}

export function ticketUrl(webUrl: string, ticketId: string): string {
    return `${webUrl.replace(/\/+$/, '')}/tickets/${ticketId}`;
}

/** Every active platform operator (`SUPER_ADMIN`) is a default staff recipient. */
export async function staffRecipients(db: NotificationDb): Promise<string[]> {
    const staff = await db.user.findMany({
        where: {
            globalRole: 'SUPER_ADMIN',
            isActive: true,
            deletedAt: null,
        },
        select: { id: true },
    });
    return staff.map(({ id }) => id);
}

function ticketMeta(ticket: TicketNotificationTicket) {
    return {
        ticketNumber: ticket.number,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
    };
}

async function publish(
    ctx: TicketNotifyContext,
    ticket: TicketNotificationTicket,
    event: {
        eventKey: string;
        type:
            | 'TICKET_CREATED'
            | 'TICKET_REPLIED'
            | 'TICKET_STATUS_CHANGED'
            | 'TICKET_ASSIGNED';
        title: string;
        body: string;
        recipients: Array<string | NotificationRecipient>;
        actorId: string;
    },
): Promise<void> {
    await ctx.notifications.publish(
        {
            eventKey: event.eventKey,
            type: event.type,
            title: event.title,
            body: event.body,
            recipients: event.recipients,
            actorId: event.actorId,
            // Tickets are platform resources: an explicit ACCOUNT scope keeps
            // cross-tenant recipients (author ↔ platform staff) reachable.
            accessScope: 'ACCOUNT',
            resourceType: 'Ticket',
            resourceId: ticket.id,
            meta: ticketMeta(ticket),
        },
        ctx.db,
    );
}

interface EmailTarget {
    id: string;
    name: string;
    email: string;
}

async function loadEmailTargets(
    db: NotificationDb,
    userIds: string[],
): Promise<EmailTarget[]> {
    const unique = [...new Set(userIds)];
    if (!unique.length) return [];
    return db.user.findMany({
        where: { id: { in: unique }, isActive: true, deletedAt: null },
        select: { id: true, name: true, email: true },
    });
}

/** New ticket → every platform operator. No email. */
export async function notifyTicketCreated(
    ctx: TicketNotifyContext,
    args: { ticket: TicketNotificationTicket; actorId: string },
): Promise<void> {
    const recipients = await staffRecipients(ctx.db);
    if (!recipients.length) return;
    await publish(ctx, args.ticket, {
        eventKey: `ticket:${args.ticket.id}:created`,
        type: 'TICKET_CREATED',
        title: `New ticket #${args.ticket.number}: ${args.ticket.subject}`,
        body: excerpt(args.ticket.subject),
        recipients,
        actorId: args.actorId,
    });
}

export interface NotifyTicketReplyArgs {
    ticket: TicketNotificationTicket;
    actorId: string;
    actorType: TicketAuthorType;
    replyId: string;
    body: string;
    isInternalNote?: boolean;
}

/**
 * A new reply. Internal notes are invisible to the user side, so they notify
 * nobody and never enqueue email.
 *
 * Staff replies go to the author; user replies go to the assignee, or to every
 * platform operator when the ticket is unassigned. Both enqueue an email.
 */
export async function notifyTicketReply(
    ctx: TicketNotifyContext,
    args: NotifyTicketReplyArgs,
): Promise<void> {
    if (args.isInternalNote === true) return;

    const { ticket } = args;
    const recipientIds =
        args.actorType === 'STAFF'
            ? [ticket.authorId]
            : ticket.assigneeId
              ? [ticket.assigneeId]
              : await staffRecipients(ctx.db);
    const recipients = recipientIds.filter((id) => id && id !== args.actorId);
    if (!recipients.length) return;

    const eventKey = `ticket:${ticket.id}:reply:${args.replyId}`;
    await publish(ctx, ticket, {
        eventKey,
        type: 'TICKET_REPLIED',
        title: `New reply on ticket #${ticket.number}`,
        body: excerpt(args.body),
        recipients,
        actorId: args.actorId,
    });

    const targets = await loadEmailTargets(ctx.db, recipients);
    const url = ticketUrl(ctx.webUrl, ticket.id);
    for (const target of targets) {
        await ctx.notifications.enqueueEmail(
            EmailTemplate.TICKET_REPLIED,
            {
                to: target.email,
                name: target.name,
                ticketNumber: ticket.number,
                subject: ticket.subject,
                body: excerpt(args.body),
                ticketUrl: url,
            },
            `${eventKey}:email:${target.id}`,
            ctx.db,
            { accessScope: 'ACCOUNT', userId: target.id, email: target.email },
        );
    }
}

export interface NotifyTicketStatusChangedArgs {
    ticket: TicketNotificationTicket;
    actorId: string;
    from: TicketStatus;
    to: TicketStatus;
}

/**
 * A status change notifies the author and the assignee (minus the actor). When
 * that leaves nobody and the ticket just reached `RESOLVED` / `CLOSED`, every
 * platform operator is told instead. Only `RESOLVED` / `CLOSED` send email, and
 * only to the author — a user closing their own ticket gets no email.
 */
export async function notifyTicketStatusChanged(
    ctx: TicketNotifyContext,
    args: NotifyTicketStatusChangedArgs,
): Promise<void> {
    if (args.from === args.to) return;

    const { ticket } = args;
    const audience = [
        ticket.authorId,
        ...(ticket.assigneeId ? [ticket.assigneeId] : []),
    ].filter((id): id is string => !!id && id !== args.actorId);

    const terminal = args.to === 'RESOLVED' || args.to === 'CLOSED';
    const recipients = audience.length
        ? audience
        : terminal
          ? await staffRecipients(ctx.db)
          : [];
    const reachable = recipients.filter((id) => id !== args.actorId);
    if (!reachable.length) return;

    const eventKey = `ticket:${ticket.id}:status:${randomUUID()}`;
    await publish(ctx, ticket, {
        eventKey,
        type: 'TICKET_STATUS_CHANGED',
        title: `Ticket #${ticket.number} is now ${args.to}`,
        body: ticket.subject,
        recipients: reachable,
        actorId: args.actorId,
    });

    if (!terminal) return;
    if (ticket.authorId === args.actorId) return;
    if (!reachable.includes(ticket.authorId)) return;

    const [target] = await loadEmailTargets(ctx.db, [ticket.authorId]);
    if (!target) return;
    await ctx.notifications.enqueueEmail(
        EmailTemplate.TICKET_STATUS_CHANGED,
        {
            to: target.email,
            name: target.name,
            ticketNumber: ticket.number,
            subject: ticket.subject,
            status: args.to,
            ticketUrl: ticketUrl(ctx.webUrl, ticket.id),
        },
        `${eventKey}:email:${target.id}`,
        ctx.db,
        { accessScope: 'ACCOUNT', userId: target.id, email: target.email },
    );
}

/** Assignment / reassignment → the new assignee only. No email. */
export async function notifyTicketAssigned(
    ctx: TicketNotifyContext,
    args: {
        ticket: TicketNotificationTicket;
        actorId: string;
        assigneeId: string;
    },
): Promise<void> {
    if (args.assigneeId === args.actorId) return;
    await publish(ctx, args.ticket, {
        eventKey: `ticket:${args.ticket.id}:assignee:${args.assigneeId}:${randomUUID()}`,
        type: 'TICKET_ASSIGNED',
        title: `Ticket #${args.ticket.number} was assigned to you`,
        body: args.ticket.subject,
        recipients: [args.assigneeId],
        actorId: args.actorId,
    });
}
