import {
    BadRequestException,
    ConflictException,
    NotFoundException,
} from '@nestjs/common';
import { AdminTicketsService } from './admin-tickets.service';
import type { PrismaService } from '../../../infra/database/prisma.service';
import type { NotificationsService } from '../../notifications/notifications.service';
import type { ConfigService } from '@nestjs/config';

const createdAt = new Date('2026-10-17T08:00:00.000Z');

const ticketRow = {
    id: 'ticket-1',
    number: 42,
    subject: 'Export fails on large workspaces',
    content: 'Posting the export endpoint returns 500.',
    status: 'OPEN',
    priority: 'MEDIUM',
    categoryId: null,
    authorId: 'author-1',
    organizationId: 'org-1',
    assigneeId: null,
    firstRespondedAt: null,
    resolvedAt: null,
    closedAt: null,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    category: null,
    author: {
        id: 'author-1',
        name: 'Ada',
        avatarUrl: null,
        email: 'ada@example.com',
    },
    assignee: null,
};

function createService() {
    const prisma = {
        ticket: {
            findFirst: jest.fn(),
            findMany: jest.fn().mockResolvedValue([]),
            count: jest.fn().mockResolvedValue(0),
            groupBy: jest.fn().mockResolvedValue([]),
            update: jest.fn(),
            updateMany: jest.fn(),
        },
        ticketReply: {
            findMany: jest.fn().mockResolvedValue([]),
            create: jest.fn(),
        },
        ticketActivity: {
            findMany: jest.fn().mockResolvedValue([]),
            create: jest.fn().mockResolvedValue({}),
        },
        ticketCategory: { findFirst: jest.fn() },
        user: {
            findFirst: jest.fn(),
            findMany: jest.fn(),
        },
    };
    Object.assign(prisma, {
        $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
            callback(prisma),
        ),
    });
    prisma.user.findMany.mockImplementation(({ where }: any) =>
        Promise.resolve(
            where?.globalRole === 'SUPER_ADMIN'
                ? [{ id: 'staff-1' }, { id: 'staff-2' }]
                : [
                      {
                          id: 'author-1',
                          name: 'Ada',
                          email: 'ada@example.com',
                      },
                  ],
        ),
    );

    const notifications = {
        publish: jest.fn().mockResolvedValue(undefined),
        enqueueEmail: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
        get: jest.fn().mockReturnValue({ webUrl: 'https://beacon.test' }),
    };

    const service = new AdminTicketsService(
        prisma as unknown as PrismaService,
        notifications as unknown as NotificationsService,
        config as unknown as ConfigService,
    );

    return { service, prisma, notifications };
}

describe('AdminTicketsService.findAll', () => {
    it('builds the filter set from every query field', async () => {
        const { service, prisma } = createService();

        await service.findAll({
            status: 'OPEN',
            priority: 'HIGH',
            categoryId: 'cat-1',
            unassigned: true,
            q: 'export',
            page: 2,
            limit: 5,
        });

        expect(prisma.ticket.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    deletedAt: null,
                    status: 'OPEN',
                    priority: 'HIGH',
                    categoryId: 'cat-1',
                    assigneeId: null,
                    OR: [
                        {
                            subject: {
                                contains: 'export',
                                mode: 'insensitive',
                            },
                        },
                        {
                            content: {
                                contains: 'export',
                                mode: 'insensitive',
                            },
                        },
                        {
                            author: {
                                email: {
                                    contains: 'export',
                                    mode: 'insensitive',
                                },
                            },
                        },
                    ],
                },
                skip: 5,
                take: 5,
            }),
        );
        expect(prisma.ticket.count).toHaveBeenCalledWith({
            where: expect.objectContaining({ deletedAt: null }),
        });
    });

    it('prefers assigneeId when the unassigned filter is off', async () => {
        const { service, prisma } = createService();

        await service.findAll({ assigneeId: 'staff-1' });

        expect(prisma.ticket.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { deletedAt: null, assigneeId: 'staff-1' },
            }),
        );
    });
});

describe('AdminTicketsService.findStats', () => {
    it('zero-fills both groupings', async () => {
        const { service, prisma } = createService();
        prisma.ticket.count.mockResolvedValueOnce(6).mockResolvedValueOnce(2);
        prisma.ticket.groupBy
            .mockResolvedValueOnce([
                { status: 'OPEN', _count: { _all: 4 } },
                { status: 'CLOSED', _count: { _all: 2 } },
            ])
            .mockResolvedValueOnce([{ priority: 'HIGH', _count: { _all: 6 } }]);

        const stats = await service.findStats();

        expect(stats).toEqual({
            total: 6,
            byStatus: { OPEN: 4, PROCESSING: 0, RESOLVED: 0, CLOSED: 2 },
            byPriority: { LOW: 0, MEDIUM: 0, HIGH: 6, CRITICAL: 0 },
            unassigned: 2,
        });
    });
});

describe('AdminTicketsService.update', () => {
    it('rejects an empty payload', async () => {
        const { service } = createService();

        await expect(service.update('ticket-1', 'staff-1', {})).rejects.toThrow(
            BadRequestException,
        );
    });

    it('rejects an illegal transition', async () => {
        const { service, prisma } = createService();
        prisma.ticket.findFirst.mockResolvedValue({
            ...ticketRow,
            status: 'CLOSED',
        });

        await expect(
            service.update('ticket-1', 'staff-1', { status: 'PROCESSING' }),
        ).rejects.toThrow(ConflictException);
        expect(prisma.ticket.update).not.toHaveBeenCalled();
    });

    it('moves the ticket to RESOLVED, records the timeline and emails the author', async () => {
        const { service, prisma, notifications } = createService();
        prisma.ticket.findFirst.mockResolvedValue(ticketRow);
        prisma.ticket.update.mockResolvedValue({
            ...ticketRow,
            status: 'RESOLVED',
            resolvedAt: createdAt,
        });

        const ticket = await service.update('ticket-1', 'staff-1', {
            status: 'RESOLVED',
        });

        expect(prisma.ticket.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: {
                    status: 'RESOLVED',
                    resolvedAt: expect.any(Date),
                    closedAt: null,
                },
            }),
        );
        expect(prisma.ticketActivity.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                type: 'STATUS_CHANGED',
                oldValue: 'OPEN',
                newValue: 'RESOLVED',
            }),
        });
        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'TICKET_STATUS_CHANGED',
                recipients: ['author-1'],
            }),
            prisma,
        );
        expect(notifications.enqueueEmail).toHaveBeenCalledTimes(1);
        expect(notifications.enqueueEmail).toHaveBeenCalledWith(
            'ticket-status-changed',
            expect.objectContaining({
                to: 'ada@example.com',
                status: 'RESOLVED',
            }),
            expect.any(String),
            prisma,
            expect.objectContaining({ userId: 'author-1' }),
        );
        expect(ticket).toMatchObject({ status: 'RESOLVED' });
    });

    it('requires the assignee to be an active platform operator', async () => {
        const { service, prisma } = createService();
        prisma.ticket.findFirst.mockResolvedValue(ticketRow);
        prisma.user.findFirst.mockResolvedValue(null);

        await expect(
            service.update('ticket-1', 'staff-1', { assigneeId: 'user-9' }),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.ticket.update).not.toHaveBeenCalled();
    });

    it('records ASSIGNED and notifies the new assignee', async () => {
        const { service, prisma, notifications } = createService();
        prisma.ticket.findFirst.mockResolvedValue(ticketRow);
        prisma.user.findFirst.mockResolvedValue({ name: 'Ops' });
        prisma.ticket.update.mockResolvedValue({
            ...ticketRow,
            assigneeId: 'staff-2',
            assignee: { id: 'staff-2', name: 'Ops', avatarUrl: null },
        });

        await service.update('ticket-1', 'staff-1', { assigneeId: 'staff-2' });

        expect(prisma.ticketActivity.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                type: 'ASSIGNED',
                field: 'assigneeId',
                newValue: 'staff-2',
                meta: { assigneeName: 'Ops' },
            }),
        });
        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'TICKET_ASSIGNED',
                recipients: ['staff-2'],
            }),
            prisma,
        );
        expect(notifications.enqueueEmail).not.toHaveBeenCalled();
    });

    it('is idempotent when nothing actually changes', async () => {
        const { service, prisma, notifications } = createService();
        prisma.ticket.findFirst.mockResolvedValue(ticketRow);

        await service.update('ticket-1', 'staff-1', {
            status: 'OPEN',
            priority: 'MEDIUM',
        });

        expect(prisma.ticket.update).not.toHaveBeenCalled();
        expect(prisma.ticketActivity.create).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it('rejects a missing or inactive category', async () => {
        const { service, prisma } = createService();
        prisma.ticket.findFirst.mockResolvedValue(ticketRow);
        prisma.ticketCategory.findFirst.mockResolvedValue(null);

        await expect(
            service.update('ticket-1', 'staff-1', { categoryId: 'cat-9' }),
        ).rejects.toThrow(BadRequestException);
    });

    it('throws 404 for a soft-deleted ticket', async () => {
        const { service, prisma } = createService();
        prisma.ticket.findFirst.mockResolvedValue(null);

        await expect(
            service.update('ticket-1', 'staff-1', { priority: 'LOW' }),
        ).rejects.toThrow(NotFoundException);
    });
});

describe('AdminTicketsService.reply', () => {
    it('picks an OPEN ticket up on the first public reply without a timeline entry', async () => {
        const { service, prisma, notifications } = createService();
        prisma.ticket.findFirst.mockResolvedValue(ticketRow);
        prisma.ticketReply.create.mockResolvedValue({
            id: 'reply-1',
            ticketId: 'ticket-1',
            authorId: 'staff-1',
            authorType: 'STAFF',
            body: 'Looking into it',
            isInternalNote: false,
            createdAt,
            author: { id: 'staff-1', name: 'Ops', avatarUrl: null },
        });
        prisma.ticket.update.mockResolvedValue({
            ...ticketRow,
            status: 'PROCESSING',
            firstRespondedAt: createdAt,
        });

        const result = await service.reply('ticket-1', 'staff-1', {
            body: 'Looking into it',
        });

        expect(prisma.ticket.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: {
                    status: 'PROCESSING',
                    firstRespondedAt: expect.any(Date),
                },
            }),
        );
        expect(prisma.ticketActivity.create).not.toHaveBeenCalled();
        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'TICKET_REPLIED',
                recipients: ['author-1'],
            }),
            prisma,
        );
        expect(result.ticket).toMatchObject({ status: 'PROCESSING' });
    });

    it('keeps the original firstRespondedAt on later replies', async () => {
        const { service, prisma } = createService();
        prisma.ticket.findFirst.mockResolvedValue({
            ...ticketRow,
            status: 'OPEN',
            firstRespondedAt: createdAt,
        });
        prisma.ticketReply.create.mockResolvedValue({
            id: 'reply-2',
            ticketId: 'ticket-1',
            authorId: 'staff-1',
            authorType: 'STAFF',
            body: 'Second reply',
            isInternalNote: false,
            createdAt,
            author: { id: 'staff-1', name: 'Ops', avatarUrl: null },
        });
        prisma.ticket.update.mockResolvedValue({
            ...ticketRow,
            status: 'PROCESSING',
            firstRespondedAt: createdAt,
        });

        await service.reply('ticket-1', 'staff-1', { body: 'Second reply' });

        expect(prisma.ticket.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: { status: 'PROCESSING' },
            }),
        );
    });

    it('does not process, notify or log for an internal note', async () => {
        const { service, prisma, notifications } = createService();
        prisma.ticket.findFirst.mockResolvedValue(ticketRow);
        prisma.ticketReply.create.mockResolvedValue({
            id: 'reply-3',
            ticketId: 'ticket-1',
            authorId: 'staff-1',
            authorType: 'STAFF',
            body: 'Internal only',
            isInternalNote: true,
            createdAt,
            author: { id: 'staff-1', name: 'Ops', avatarUrl: null },
        });

        await service.reply('ticket-1', 'staff-1', {
            body: 'Internal only',
            isInternalNote: true,
        });

        expect(prisma.ticket.update).not.toHaveBeenCalled();
        expect(prisma.ticketActivity.create).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
        expect(notifications.enqueueEmail).not.toHaveBeenCalled();
    });
});

describe('AdminTicketsService.remove', () => {
    it('soft-deletes without touching the timeline or notifications', async () => {
        const { service, prisma, notifications } = createService();
        prisma.ticket.updateMany.mockResolvedValue({ count: 1 });

        await service.remove('ticket-1');

        expect(prisma.ticket.updateMany).toHaveBeenCalledWith({
            where: { id: 'ticket-1', deletedAt: null },
            data: { deletedAt: expect.any(Date) },
        });
        expect(prisma.ticketActivity.create).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it('throws 404 when the ticket is already gone', async () => {
        const { service, prisma } = createService();
        prisma.ticket.updateMany.mockResolvedValue({ count: 0 });

        await expect(service.remove('ticket-1')).rejects.toThrow(
            NotFoundException,
        );
    });
});
