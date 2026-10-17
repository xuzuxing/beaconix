import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { AppConfig } from '../../config';
import { CreateTicketDto, CreateTicketReplyDto, QueryTicketsDto } from './dto';
import { TicketEntity, TicketReplyEntity } from './entities';
import { assertTransition, statusTimestamps } from './ticket-state';
import {
    createdActivity,
    mergeTimeline,
    recordActivity,
    statusChangedActivity,
} from './ticket-activity';
import {
    notifyTicketCreated,
    notifyTicketReply,
    notifyTicketStatusChanged,
    TicketNotifyContext,
} from './ticket-notifications';

/** Timeline windows are capped; a single ticket thread stays far below this. */
export const TICKET_TIMELINE_LIMIT = 500;

const userSelect = {
    id: true,
    name: true,
    avatarUrl: true,
} as const;

const ticketInclude = {
    category: true,
    author: { select: userSelect },
    assignee: { select: userSelect },
} as const;

@Injectable()
export class TicketsService {
    private readonly webUrl: string;

    constructor(
        private readonly prisma: PrismaService,
        private readonly notifications: NotificationsService,
        configService: ConfigService,
    ) {
        this.webUrl = configService.get<AppConfig>('app')!.webUrl;
    }

    // ── User endpoints ──────────────────────────────────────────────────

    async create(userId: string, dto: CreateTicketDto): Promise<TicketEntity> {
        if (dto.categoryId) await this.ensureCategoryAvailable(dto.categoryId);
        const organizationId = await this.resolveOrganizationId(userId);

        // `number` is a global counter guarded by a unique index: a concurrent
        // insert can still win the race, so retry once.
        for (let attempt = 0; ; attempt += 1) {
            try {
                const ticket = await this.prisma.$transaction(async (tx) => {
                    const last = await tx.ticket.findFirst({
                        orderBy: { number: 'desc' },
                        select: { number: true },
                    });
                    const created = await tx.ticket.create({
                        data: {
                            number: (last?.number ?? 0) + 1,
                            subject: dto.subject,
                            content: dto.content,
                            priority: dto.priority ?? 'MEDIUM',
                            categoryId: dto.categoryId ?? null,
                            authorId: userId,
                            organizationId,
                        },
                        include: ticketInclude,
                    });
                    await recordActivity(
                        tx,
                        createdActivity(created.id, userId),
                    );
                    await notifyTicketCreated(this.notifyContext(tx), {
                        ticket: created,
                        actorId: userId,
                    });
                    return created;
                });
                return new TicketEntity(ticket);
            } catch (error) {
                if (attempt === 0 && this.isUniqueViolation(error)) continue;
                throw error;
            }
        }
    }

    async findMine(userId: string, query: QueryTicketsDto) {
        const page = query.page ?? 1;
        const limit = query.limit ?? 20;
        const where: Prisma.TicketWhereInput = {
            authorId: userId,
            deletedAt: null,
            ...(query.status ? { status: query.status } : {}),
            ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        };
        const [tickets, total] = await Promise.all([
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
            data: tickets.map((ticket) => new TicketEntity(ticket)),
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        };
    }

    async findOne(userId: string, ticketId: string) {
        const ticket = await this.prisma.ticket.findFirst({
            where: { id: ticketId, authorId: userId, deletedAt: null },
            include: ticketInclude,
        });
        if (!ticket) throw new NotFoundException('Ticket not found');

        const [replies, activities] = await Promise.all([
            this.prisma.ticketReply.findMany({
                // Internal notes never reach the user side.
                where: { ticketId, isInternalNote: false },
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

    async reply(userId: string, ticketId: string, dto: CreateTicketReplyDto) {
        return this.prisma.$transaction(async (tx) => {
            const ticket = await this.findOwnedTicket(ticketId, userId, tx);

            const reply = await tx.ticketReply.create({
                data: {
                    ticketId,
                    authorId: userId,
                    authorType: 'USER',
                    body: dto.body,
                },
                include: { author: { select: userSelect } },
            });

            // Replying to a resolved/closed ticket reopens it.
            const reopens =
                ticket.status === 'RESOLVED' || ticket.status === 'CLOSED';
            let current = ticket;
            if (reopens) {
                assertTransition(ticket.status, 'OPEN');
                current = await tx.ticket.update({
                    where: { id: ticketId },
                    data: { status: 'OPEN', ...statusTimestamps('OPEN') },
                    include: ticketInclude,
                });
                const activity = statusChangedActivity({
                    ticketId,
                    actorId: userId,
                    actorType: 'USER',
                    from: ticket.status,
                    to: 'OPEN',
                });
                if (activity) await recordActivity(tx, activity);
            }

            await notifyTicketReply(this.notifyContext(tx), {
                ticket: current,
                actorId: userId,
                actorType: 'USER',
                replyId: reply.id,
                body: dto.body,
            });

            return {
                ticket: new TicketEntity(current),
                reply: new TicketReplyEntity(reply),
            };
        });
    }

    async close(userId: string, ticketId: string): Promise<TicketEntity> {
        return this.prisma.$transaction(async (tx) => {
            const ticket = await this.findOwnedTicket(ticketId, userId, tx);
            if (ticket.status === 'CLOSED') {
                throw new ConflictException({
                    code: 'TICKET_ALREADY_CLOSED',
                    message: 'Ticket is already closed',
                });
            }
            assertTransition(ticket.status, 'CLOSED');

            const updated = await tx.ticket.update({
                where: { id: ticketId },
                data: { status: 'CLOSED', ...statusTimestamps('CLOSED') },
                include: ticketInclude,
            });
            const activity = statusChangedActivity({
                ticketId,
                actorId: userId,
                actorType: 'USER',
                from: ticket.status,
                to: 'CLOSED',
            });
            if (activity) await recordActivity(tx, activity);
            await notifyTicketStatusChanged(this.notifyContext(tx), {
                ticket: updated,
                actorId: userId,
                from: ticket.status,
                to: 'CLOSED',
            });

            return new TicketEntity(updated);
        });
    }

    // ── Internals ───────────────────────────────────────────────────────

    private notifyContext(db: Prisma.TransactionClient): TicketNotifyContext {
        return { db, notifications: this.notifications, webUrl: this.webUrl };
    }

    private async findOwnedTicket(
        ticketId: string,
        userId: string,
        db: Prisma.TransactionClient,
    ) {
        const ticket = await db.ticket.findFirst({
            // Author isolation: unknown or foreign tickets are indistinguishable.
            where: { id: ticketId, authorId: userId, deletedAt: null },
            include: ticketInclude,
        });
        if (!ticket) throw new NotFoundException('Ticket not found');
        return ticket;
    }

    private async ensureCategoryAvailable(categoryId: string): Promise<void> {
        const category = await this.prisma.ticketCategory.findFirst({
            where: { id: categoryId, isActive: true },
            select: { id: true },
        });
        if (!category) {
            throw new BadRequestException(
                'Ticket category is missing or inactive',
            );
        }
    }

    /**
     * Snapshot of the author's earliest valid organization. Only used for
     * platform-side identification, so a failure here must not block creation.
     */
    private async resolveOrganizationId(
        userId: string,
    ): Promise<string | null> {
        try {
            const membership = await this.prisma.membership.findFirst({
                where: { userId, organization: { deletedAt: null } },
                orderBy: { joinedAt: 'asc' },
                select: { organizationId: true },
            });
            return membership?.organizationId ?? null;
        } catch {
            return null;
        }
    }

    private isUniqueViolation(error: unknown): boolean {
        return (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
        );
    }
}
