import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../../generated/prisma/client';
import type {
    TicketPriority,
    TicketStatus,
} from '../../../generated/prisma/enums';
import { PrismaService } from '../../../infra/database/prisma.service';
import type { AppConfig } from '../../../config';
import { NotificationsService } from '../../notifications/notifications.service';
import {
    AdminTicketReplyDto,
    QueryAdminTicketsDto,
    UpdateTicketDto,
} from './dto';
import { TicketEntity, TicketReplyEntity } from '../../tickets/entities';
import {
    assigneeChangedActivity,
    categoryChangedActivity,
    mergeTimeline,
    priorityChangedActivity,
    recordActivity,
    statusChangedActivity,
    TicketActivityInput,
} from '../../tickets/ticket-activity';
import { assertTransition, statusTimestamps } from '../../tickets/ticket-state';
import {
    notifyTicketAssigned,
    notifyTicketReply,
    notifyTicketStatusChanged,
    TicketNotifyContext,
} from '../../tickets/ticket-notifications';
import { TICKET_TIMELINE_LIMIT } from '../../tickets/tickets.service';

const userSelect = {
    id: true,
    name: true,
    avatarUrl: true,
} as const;

const ticketInclude = {
    category: true,
    author: { select: { ...userSelect, email: true } },
    assignee: { select: userSelect },
} as const;

export interface AdminTicketStats {
    total: number;
    byStatus: Record<TicketStatus, number>;
    byPriority: Record<TicketPriority, number>;
    unassigned: number;
}

@Injectable()
export class AdminTicketsService {
    private readonly webUrl: string;

    constructor(
        private readonly prisma: PrismaService,
        private readonly notifications: NotificationsService,
        configService: ConfigService,
    ) {
        this.webUrl = configService.get<AppConfig>('app')!.webUrl;
    }

    // ── Read ────────────────────────────────────────────────────────────

    async findAll(query: QueryAdminTicketsDto) {
        const page = query.page ?? 1;
        const limit = query.limit ?? 20;
        const where = this.buildWhere(query);
        const [items, total] = await Promise.all([
            this.prisma.ticket.findMany({
                where,
                include: ticketInclude,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            this.prisma.ticket.count({ where }),
        ]);
        return {
            items: items.map((ticket) => new TicketEntity(ticket)),
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        };
    }

    async findStats(): Promise<AdminTicketStats> {
        const where: Prisma.TicketWhereInput = { deletedAt: null };
        const [total, byStatusRows, byPriorityRows, unassigned] =
            await Promise.all([
                this.prisma.ticket.count({ where }),
                this.prisma.ticket.groupBy({
                    by: ['status'],
                    where,
                    _count: { _all: true },
                }),
                this.prisma.ticket.groupBy({
                    by: ['priority'],
                    where,
                    _count: { _all: true },
                }),
                this.prisma.ticket.count({
                    where: { ...where, assigneeId: null },
                }),
            ]);

        const byStatus: Record<TicketStatus, number> = {
            OPEN: 0,
            PROCESSING: 0,
            RESOLVED: 0,
            CLOSED: 0,
        };
        for (const row of byStatusRows) byStatus[row.status] = row._count._all;

        const byPriority: Record<TicketPriority, number> = {
            LOW: 0,
            MEDIUM: 0,
            HIGH: 0,
            CRITICAL: 0,
        };
        for (const row of byPriorityRows)
            byPriority[row.priority] = row._count._all;

        return { total, byStatus, byPriority, unassigned };
    }

    /** Full detail including internal notes and the merged timeline. */
    async findOne(ticketId: string) {
        const ticket = await this.prisma.ticket.findFirst({
            where: { id: ticketId, deletedAt: null },
            include: ticketInclude,
        });
        if (!ticket) throw new NotFoundException('Ticket not found');

        const [replies, activities] = await Promise.all([
            this.prisma.ticketReply.findMany({
                where: { ticketId },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                take: TICKET_TIMELINE_LIMIT,
                include: { author: { select: userSelect } },
            }),
            this.prisma.ticketActivity.findMany({
                where: { ticketId },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                take: TICKET_TIMELINE_LIMIT,
                include: { actor: { select: userSelect } },
            }),
        ]);

        return {
            ...new TicketEntity(ticket),
            timeline: mergeTimeline(replies, activities),
            timelineTruncated:
                replies.length >= TICKET_TIMELINE_LIMIT ||
                activities.length >= TICKET_TIMELINE_LIMIT,
        };
    }

    // ── Write ───────────────────────────────────────────────────────────

    async update(ticketId: string, actorId: string, dto: UpdateTicketDto) {
        if (
            dto.status === undefined &&
            dto.priority === undefined &&
            dto.categoryId === undefined &&
            dto.assigneeId === undefined
        ) {
            throw new BadRequestException('At least one field is required');
        }

        return this.prisma.$transaction(async (tx) => {
            const ticket = await this.requireTicket(ticketId, tx);
            const data: Prisma.TicketUncheckedUpdateInput = {};
            const activities: TicketActivityInput[] = [];
            let statusChange: { from: TicketStatus; to: TicketStatus } | null =
                null;
            let assignedTo: string | null = null;

            if (dto.status !== undefined && dto.status !== ticket.status) {
                assertTransition(ticket.status, dto.status);
                data.status = dto.status;
                Object.assign(data, statusTimestamps(dto.status));
                statusChange = { from: ticket.status, to: dto.status };
                const activity = statusChangedActivity({
                    ticketId,
                    actorId,
                    actorType: 'STAFF',
                    from: ticket.status,
                    to: dto.status,
                });
                if (activity) activities.push(activity);
            }

            if (
                dto.priority !== undefined &&
                dto.priority !== ticket.priority
            ) {
                data.priority = dto.priority;
                const activity = priorityChangedActivity({
                    ticketId,
                    actorId,
                    actorType: 'STAFF',
                    from: ticket.priority,
                    to: dto.priority,
                });
                if (activity) activities.push(activity);
            }

            if (
                dto.categoryId !== undefined &&
                (dto.categoryId ?? null) !== ticket.categoryId
            ) {
                const nextCategoryId = dto.categoryId ?? null;
                let categoryName: string | null = null;
                if (nextCategoryId) {
                    const category = await tx.ticketCategory.findFirst({
                        where: { id: nextCategoryId, isActive: true },
                        select: { name: true },
                    });
                    if (!category) {
                        throw new BadRequestException(
                            'Ticket category is missing or inactive',
                        );
                    }
                    categoryName = category.name;
                }
                data.categoryId = nextCategoryId;
                const activity = categoryChangedActivity({
                    ticketId,
                    actorId,
                    actorType: 'STAFF',
                    from: ticket.categoryId,
                    to: nextCategoryId,
                    categoryName,
                });
                if (activity) activities.push(activity);
            }

            if (
                dto.assigneeId !== undefined &&
                (dto.assigneeId ?? null) !== ticket.assigneeId
            ) {
                const nextAssigneeId = dto.assigneeId ?? null;
                let assigneeName: string | null = null;
                if (nextAssigneeId) {
                    const staff = await tx.user.findFirst({
                        where: {
                            id: nextAssigneeId,
                            globalRole: 'SUPER_ADMIN',
                            isActive: true,
                            deletedAt: null,
                        },
                        select: { name: true },
                    });
                    if (!staff) {
                        throw new BadRequestException(
                            'Assignee must be an active platform operator',
                        );
                    }
                    assigneeName = staff.name;
                }
                data.assigneeId = nextAssigneeId;
                assignedTo = nextAssigneeId;
                const activity = assigneeChangedActivity({
                    ticketId,
                    actorId,
                    actorType: 'STAFF',
                    from: ticket.assigneeId,
                    to: nextAssigneeId,
                    assigneeName,
                });
                if (activity) activities.push(activity);
            }

            // Same-value PATCH is idempotent: no write, no timeline, no notice.
            if (!Object.keys(data).length) return new TicketEntity(ticket);

            const updated = await tx.ticket.update({
                where: { id: ticketId },
                data,
                include: ticketInclude,
            });
            for (const activity of activities) {
                await recordActivity(tx, activity);
            }

            const ctx = this.notifyContext(tx);
            if (statusChange) {
                await notifyTicketStatusChanged(ctx, {
                    ticket: updated,
                    actorId,
                    from: statusChange.from,
                    to: statusChange.to,
                });
            }
            if (assignedTo) {
                await notifyTicketAssigned(ctx, {
                    ticket: updated,
                    actorId,
                    assigneeId: assignedTo,
                });
            }

            return new TicketEntity(updated);
        });
    }

    async reply(ticketId: string, actorId: string, dto: AdminTicketReplyDto) {
        return this.prisma.$transaction(async (tx) => {
            const ticket = await this.requireTicket(ticketId, tx);
            const isInternalNote = dto.isInternalNote === true;

            const reply = await tx.ticketReply.create({
                data: {
                    ticketId,
                    authorId: actorId,
                    authorType: 'STAFF',
                    body: dto.body,
                    isInternalNote,
                },
                include: { author: { select: userSelect } },
            });

            // The first public reply picks the ticket up. The transition is not
            // written to the timeline — the reply itself is the evidence.
            let current = ticket;
            if (!isInternalNote && ticket.status === 'OPEN') {
                current = await tx.ticket.update({
                    where: { id: ticketId },
                    data: {
                        status: 'PROCESSING',
                        ...(ticket.firstRespondedAt
                            ? {}
                            : { firstRespondedAt: new Date() }),
                    },
                    include: ticketInclude,
                });
            }

            await notifyTicketReply(this.notifyContext(tx), {
                ticket: current,
                actorId,
                actorType: 'STAFF',
                replyId: reply.id,
                body: dto.body,
                isInternalNote,
            });

            return {
                ticket: new TicketEntity(current),
                reply: new TicketReplyEntity(reply),
            };
        });
    }

    /** Soft-deletes a spam/test ticket. No timeline entry, no notification. */
    async remove(ticketId: string): Promise<void> {
        const updated = await this.prisma.ticket.updateMany({
            where: { id: ticketId, deletedAt: null },
            data: { deletedAt: new Date() },
        });
        if (!updated.count) throw new NotFoundException('Ticket not found');
    }

    // ── Internals ───────────────────────────────────────────────────────

    private buildWhere(query: QueryAdminTicketsDto): Prisma.TicketWhereInput {
        const where: Prisma.TicketWhereInput = { deletedAt: null };
        if (query.status) where.status = query.status;
        if (query.priority) where.priority = query.priority;
        if (query.categoryId) where.categoryId = query.categoryId;
        if (query.unassigned) where.assigneeId = null;
        else if (query.assigneeId) where.assigneeId = query.assigneeId;
        if (query.q) {
            where.OR = [
                { subject: { contains: query.q, mode: 'insensitive' } },
                { content: { contains: query.q, mode: 'insensitive' } },
                {
                    author: {
                        email: { contains: query.q, mode: 'insensitive' },
                    },
                },
            ];
        }
        return where;
    }

    private async requireTicket(
        ticketId: string,
        db: Prisma.TransactionClient,
    ) {
        const ticket = await db.ticket.findFirst({
            where: { id: ticketId, deletedAt: null },
            include: ticketInclude,
        });
        if (!ticket) throw new NotFoundException('Ticket not found');
        return ticket;
    }

    private notifyContext(db: Prisma.TransactionClient): TicketNotifyContext {
        return { db, notifications: this.notifications, webUrl: this.webUrl };
    }
}
