import type { Prisma } from '../../generated/prisma/client';
import type {
    TicketActivityType,
    TicketAuthorType,
} from '../../generated/prisma/enums';

/**
 * Minimal database surface this module needs. Keeping it structural (instead of
 * importing `PrismaService`) lets the activity helpers stay dependency-free and
 * unit-testable without a Nest container.
 */
export type TicketActivityDb = Pick<Prisma.TransactionClient, 'ticketActivity'>;

export interface TicketActivityInput {
    ticketId: string;
    actorId: string | null;
    actorType: TicketAuthorType;
    type: TicketActivityType;
    field?: string | null;
    oldValue?: string | null;
    newValue?: string | null;
    meta?: Record<string, unknown>;
}

export interface TicketTimelineActor {
    id: string;
    name: string;
    avatarUrl: string | null;
}

export interface TicketReplyTimelineItem {
    kind: 'reply';
    id: string;
    authorType: TicketAuthorType;
    author: TicketTimelineActor | null;
    body: string;
    isInternalNote: boolean;
    createdAt: Date;
}

export interface TicketActivityTimelineItem {
    kind: 'activity';
    id: string;
    actorType: TicketAuthorType;
    actor: TicketTimelineActor | null;
    type: TicketActivityType;
    field: string | null;
    oldValue: string | null;
    newValue: string | null;
    meta: Record<string, unknown>;
    createdAt: Date;
}

export type TicketTimelineItem =
    TicketReplyTimelineItem | TicketActivityTimelineItem;

export interface TicketReplyRow {
    id: string;
    authorType: TicketAuthorType;
    body: string;
    isInternalNote: boolean;
    createdAt: Date;
    author: TicketTimelineActor | null;
}

export interface TicketActivityRow {
    id: string;
    actorType: TicketAuthorType;
    type: TicketActivityType;
    field: string | null;
    oldValue: string | null;
    newValue: string | null;
    meta: Prisma.JsonValue;
    createdAt: Date;
    actor: TicketTimelineActor | null;
}

/** The only writer of `TicketActivity` rows. */
export async function recordActivity(
    db: TicketActivityDb,
    activity: TicketActivityInput,
): Promise<void> {
    await db.ticketActivity.create({
        data: {
            ticketId: activity.ticketId,
            actorId: activity.actorId,
            actorType: activity.actorType,
            type: activity.type,
            field: activity.field ?? null,
            oldValue: activity.oldValue ?? null,
            newValue: activity.newValue ?? null,
            meta: (activity.meta ?? {}) as Prisma.InputJsonValue,
        },
    });
}

export function createdActivity(
    ticketId: string,
    actorId: string,
    actorType: TicketAuthorType = 'USER',
): TicketActivityInput {
    return { ticketId, actorId, actorType, type: 'CREATED' };
}

interface StatusChangeArgs {
    ticketId: string;
    actorId: string;
    actorType: TicketAuthorType;
    from: string;
    to: string;
}

export function statusChangedActivity(
    args: StatusChangeArgs,
): TicketActivityInput | null {
    if (args.from === args.to) return null;
    return {
        ticketId: args.ticketId,
        actorId: args.actorId,
        actorType: args.actorType,
        type: 'STATUS_CHANGED',
        field: 'status',
        oldValue: args.from,
        newValue: args.to,
    };
}

export function priorityChangedActivity(
    args: StatusChangeArgs,
): TicketActivityInput | null {
    if (args.from === args.to) return null;
    return {
        ticketId: args.ticketId,
        actorId: args.actorId,
        actorType: args.actorType,
        type: 'PRIORITY_CHANGED',
        field: 'priority',
        oldValue: args.from,
        newValue: args.to,
    };
}

interface CategoryChangeArgs {
    ticketId: string;
    actorId: string;
    actorType: TicketAuthorType;
    from: string | null;
    to: string | null;
    /** Snapshot of the new category name; `null` when the category is cleared. */
    categoryName: string | null;
}

export function categoryChangedActivity(
    args: CategoryChangeArgs,
): TicketActivityInput | null {
    if (args.from === args.to) return null;
    return {
        ticketId: args.ticketId,
        actorId: args.actorId,
        actorType: args.actorType,
        type: 'CATEGORY_CHANGED',
        field: 'categoryId',
        oldValue: args.from,
        newValue: args.to,
        meta: { categoryName: args.categoryName },
    };
}

interface AssigneeChangeArgs {
    ticketId: string;
    actorId: string;
    actorType: TicketAuthorType;
    from: string | null;
    to: string | null;
    /** Snapshot of the new assignee name; `null` when unassigned. */
    assigneeName: string | null;
}

export function assigneeChangedActivity(
    args: AssigneeChangeArgs,
): TicketActivityInput | null {
    if (args.from === args.to) return null;
    return {
        ticketId: args.ticketId,
        actorId: args.actorId,
        actorType: args.actorType,
        type: args.to ? 'ASSIGNED' : 'UNASSIGNED',
        field: 'assigneeId',
        oldValue: args.from,
        newValue: args.to,
        meta: { assigneeName: args.assigneeName },
    };
}

function toMeta(value: Prisma.JsonValue): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    return {};
}

/**
 * Merges replies and timeline events into one ascending feed.
 *
 * Ordering is stable: same timestamp puts a reply before an activity (a reply
 * is the more meaningful item at that instant), then `id` breaks remaining ties.
 */
export function mergeTimeline(
    replies: TicketReplyRow[],
    activities: TicketActivityRow[],
): TicketTimelineItem[] {
    const items: TicketTimelineItem[] = [
        ...replies.map((reply): TicketReplyTimelineItem => ({
            kind: 'reply',
            id: reply.id,
            authorType: reply.authorType,
            author: reply.author,
            body: reply.body,
            isInternalNote: reply.isInternalNote,
            createdAt: reply.createdAt,
        })),
        ...activities.map((activity): TicketActivityTimelineItem => ({
            kind: 'activity',
            id: activity.id,
            actorType: activity.actorType,
            actor: activity.actor,
            type: activity.type,
            field: activity.field,
            oldValue: activity.oldValue,
            newValue: activity.newValue,
            meta: toMeta(activity.meta),
            createdAt: activity.createdAt,
        })),
    ];

    return items.sort((a, b) => {
        const byTime = a.createdAt.getTime() - b.createdAt.getTime();
        if (byTime !== 0) return byTime;
        if (a.kind !== b.kind) return a.kind === 'reply' ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}
