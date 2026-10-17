import {
    BadRequestException,
    ConflictException,
    NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { TicketsService } from './tickets.service';
import type { PrismaService } from '../../infra/database/prisma.service';
import type { AttachmentsService } from '../attachments/attachments.service';
import type { NotificationsService } from '../notifications/notifications.service';
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
    authorId: 'user-1',
    organizationId: 'org-1',
    assigneeId: null,
    firstRespondedAt: null,
    resolvedAt: null,
    closedAt: null,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    category: null,
    author: { id: 'user-1', name: 'Ada', avatarUrl: null },
    assignee: null,
};

function createService() {
    const prisma = {
        ticket: {
            findFirst: jest.fn(),
            findMany: jest.fn(),
            count: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
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
        membership: { findFirst: jest.fn() },
        user: { findMany: jest.fn() },
    };
    Object.assign(prisma, {
        $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
            callback(prisma),
        ),
    });
    prisma.user.findMany.mockImplementation(({ where }: any) =>
        Promise.resolve(
            where?.globalRole === 'SUPER_ADMIN'
                ? [{ id: 'staff-1' }]
                : [{ id: 'staff-1', name: 'Ops', email: 'ops@example.com' }],
        ),
    );

    const notifications = {
        publish: jest.fn().mockResolvedValue(undefined),
        enqueueEmail: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
        get: jest.fn().mockReturnValue({ webUrl: 'https://beacon.test' }),
    };

    const attachments = {
        claimForTicket: jest.fn().mockResolvedValue([]),
        toTicketAttachmentRefs: jest
            .fn()
            .mockImplementation((rows: unknown[] | undefined) =>
                Promise.resolve(rows ?? []),
            ),
    };

    const service = new TicketsService(
        prisma as unknown as PrismaService,
        notifications as unknown as NotificationsService,
        attachments as unknown as AttachmentsService,
        config as unknown as ConfigService,
    );

    return { service, prisma, notifications, attachments };
}

describe('TicketsService.create', () => {
    it('increments the ticket number, records CREATED and notifies operators', async () => {
        const { service, prisma, notifications } = createService();
        prisma.membership.findFirst.mockResolvedValue({
            organizationId: 'org-9',
        });
        prisma.ticket.findFirst.mockResolvedValue({ number: 41 });
        prisma.ticket.create.mockResolvedValue({ ...ticketRow, number: 42 });

        const ticket = await service.create('user-1', {
            subject: 'Export fails on large workspaces',
            content: 'Posting the export endpoint returns 500.',
        });

        expect(prisma.ticket.create).toHaveBeenCalledWith({
            data: {
                number: 42,
                subject: 'Export fails on large workspaces',
                content: 'Posting the export endpoint returns 500.',
                priority: 'MEDIUM',
                categoryId: null,
                authorId: 'user-1',
                organizationId: 'org-9',
            },
            include: expect.anything(),
        });
        expect(prisma.ticketActivity.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                ticketId: 'ticket-1',
                actorId: 'user-1',
                actorType: 'USER',
                type: 'CREATED',
            }),
        });
        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'TICKET_CREATED',
                recipients: ['staff-1'],
                accessScope: 'ACCOUNT',
            }),
            prisma,
        );
        expect(ticket).toMatchObject({ id: 'ticket-1', number: 42 });
    });

    it('claims uploaded attachments for the new ticket', async () => {
        const { service, prisma, attachments } = createService();
        prisma.membership.findFirst.mockResolvedValue({
            organizationId: 'org-9',
        });
        prisma.ticket.findFirst.mockResolvedValue({ number: 41 });
        prisma.ticket.create.mockResolvedValue({
            ...ticketRow,
            attachments: [],
        });
        attachments.claimForTicket.mockResolvedValue([
            {
                filename: 'error.log',
                mimeType: 'text/plain',
                size: 5,
                url: '',
                fileKey: 'tickets/2026/10/error.log',
            },
        ]);

        await service.create('user-1', {
            subject: 'Export fails on large workspaces',
            content: 'Posting the export endpoint returns 500.',
            attachments: [
                {
                    filename: 'error.log',
                    mimeType: 'text/plain',
                    size: 5,
                    url: '/api/attachments/object?key=tickets/2026/10/error.log',
                    fileKey: 'tickets/2026/10/error.log',
                },
            ],
        });

        expect(attachments.claimForTicket).toHaveBeenCalledWith(
            expect.anything(),
            expect.any(Array),
            { ticketId: 'ticket-1' },
            'user-1',
        );
    });

    it('retries once on a number collision', async () => {
        const { service, prisma } = createService();
        prisma.membership.findFirst.mockResolvedValue(null);
        prisma.ticket.findFirst.mockResolvedValue({ number: 41 });
        prisma.ticket.create
            .mockRejectedValueOnce(
                new Prisma.PrismaClientKnownRequestError('unique', {
                    code: 'P2002',
                    clientVersion: 'test',
                }),
            )
            .mockResolvedValueOnce(ticketRow);

        await expect(
            service.create('user-1', {
                subject: 'Retry me',
                content: 'body',
            }),
        ).resolves.toMatchObject({ id: 'ticket-1' });
        expect(prisma.ticket.create).toHaveBeenCalledTimes(2);
    });

    it('rethrows non-unique failures', async () => {
        const { service, prisma } = createService();
        prisma.membership.findFirst.mockResolvedValue(null);
        prisma.ticket.findFirst.mockResolvedValue(null);
        prisma.ticket.create.mockRejectedValue(new Error('db down'));

        await expect(
            service.create('user-1', { subject: 'Boom', content: 'body' }),
        ).rejects.toThrow('db down');
        expect(prisma.ticket.create).toHaveBeenCalledTimes(1);
    });

    it('rejects a missing or disabled category', async () => {
        const { service, prisma, notifications } = createService();
        prisma.ticketCategory.findFirst.mockResolvedValue(null);

        await expect(
            service.create('user-1', {
                subject: 'Categorised',
                content: 'body',
                categoryId: 'cat-1',
            }),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.ticket.create).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it('still creates the ticket when the organization snapshot fails', async () => {
        const { service, prisma } = createService();
        prisma.membership.findFirst.mockRejectedValue(
            new Error('lookup failed'),
        );
        prisma.ticket.findFirst.mockResolvedValue(null);
        prisma.ticket.create.mockResolvedValue(ticketRow);

        await expect(
            service.create('user-1', { subject: 'No org', content: 'body' }),
        ).resolves.toMatchObject({ id: 'ticket-1' });
        expect(prisma.ticket.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ organizationId: null }),
            }),
        );
    });
});

describe('TicketsService.findMine', () => {
    it('scopes every query to the caller and paginates', async () => {
        const { service, prisma } = createService();
        prisma.ticket.findMany.mockResolvedValue([ticketRow]);
        prisma.ticket.count.mockResolvedValue(1);

        const result = await service.findMine('user-1', {
            status: 'OPEN',
            page: 2,
            limit: 10,
        });

        expect(prisma.ticket.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { authorId: 'user-1', deletedAt: null, status: 'OPEN' },
                skip: 10,
                take: 10,
            }),
        );
        expect(result).toMatchObject({
            total: 1,
            page: 2,
            limit: 10,
            totalPages: 1,
        });
        expect(result.items[0]).toMatchObject({ id: 'ticket-1' });
    });
});

describe('TicketsService.findOne', () => {
    it('throws 404 for a ticket owned by somebody else', async () => {
        const { service, prisma } = createService();
        prisma.ticket.findFirst.mockResolvedValue(null);

        await expect(service.findOne('user-2', 'ticket-1')).rejects.toThrow(
            NotFoundException,
        );
        expect(prisma.ticket.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'ticket-1', authorId: 'user-2', deletedAt: null },
            }),
        );
    });

    it('hides internal notes and merges the timeline', async () => {
        const { service, prisma } = createService();
        prisma.ticket.findFirst.mockResolvedValue(ticketRow);
        prisma.ticketReply.findMany.mockResolvedValue([
            {
                id: 'reply-1',
                authorType: 'STAFF',
                body: 'Looking into it',
                isInternalNote: false,
                createdAt,
                author: { id: 'staff-1', name: 'Ops', avatarUrl: null },
            },
        ]);
        prisma.ticketActivity.findMany.mockResolvedValue([
            {
                id: 'activity-1',
                actorType: 'USER',
                type: 'CREATED',
                field: null,
                oldValue: null,
                newValue: null,
                meta: {},
                createdAt,
                actor: { id: 'user-1', name: 'Ada', avatarUrl: null },
            },
        ]);

        const detail = await service.findOne('user-1', 'ticket-1');

        expect(prisma.ticketReply.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { ticketId: 'ticket-1', isInternalNote: false },
            }),
        );
        expect(detail.timeline.map((item) => item.kind)).toEqual([
            'reply',
            'activity',
        ]);
        expect(detail.timelineTruncated).toBe(false);
    });
});

describe('TicketsService.reply', () => {
    it('reopens a resolved ticket and records the transition', async () => {
        const { service, prisma, notifications } = createService();
        prisma.ticket.findFirst.mockResolvedValue({
            ...ticketRow,
            status: 'RESOLVED',
            resolvedAt: createdAt,
        });
        prisma.ticketReply.create.mockResolvedValue({
            id: 'reply-9',
            ticketId: 'ticket-1',
            authorId: 'user-1',
            authorType: 'USER',
            body: 'Still broken',
            isInternalNote: false,
            createdAt,
            author: { id: 'user-1', name: 'Ada', avatarUrl: null },
        });
        prisma.ticket.update.mockResolvedValue({
            ...ticketRow,
            status: 'OPEN',
            resolvedAt: null,
        });

        const result = await service.reply('user-1', 'ticket-1', {
            body: 'Still broken',
        });

        expect(prisma.ticket.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: {
                    status: 'OPEN',
                    resolvedAt: null,
                    closedAt: null,
                },
            }),
        );
        expect(prisma.ticketActivity.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                type: 'STATUS_CHANGED',
                oldValue: 'RESOLVED',
                newValue: 'OPEN',
            }),
        });
        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'TICKET_REPLIED',
                accessScope: 'ACCOUNT',
            }),
            prisma,
        );
        expect(result.ticket).toMatchObject({ status: 'OPEN' });
        expect(result.reply).toMatchObject({ id: 'reply-9' });
    });

    it('keeps the status when replying to an open ticket', async () => {
        const { service, prisma } = createService();
        prisma.ticket.findFirst.mockResolvedValue(ticketRow);
        prisma.ticketReply.create.mockResolvedValue({
            id: 'reply-10',
            ticketId: 'ticket-1',
            authorId: 'user-1',
            authorType: 'USER',
            body: 'Ping',
            isInternalNote: false,
            createdAt,
            author: { id: 'user-1', name: 'Ada', avatarUrl: null },
        });

        const result = await service.reply('user-1', 'ticket-1', {
            body: 'Ping',
        });

        expect(prisma.ticket.update).not.toHaveBeenCalled();
        expect(prisma.ticketActivity.create).not.toHaveBeenCalled();
        expect(result.ticket).toMatchObject({ status: 'OPEN' });
    });
});

describe('TicketsService.close', () => {
    it.each(['OPEN', 'PROCESSING', 'RESOLVED'])(
        'closes a %s ticket and records the transition',
        async (status) => {
            const { service, prisma, notifications } = createService();
            prisma.ticket.findFirst.mockResolvedValue({
                ...ticketRow,
                status,
            });
            prisma.ticket.update.mockResolvedValue({
                ...ticketRow,
                status: 'CLOSED',
                closedAt: createdAt,
            });

            const ticket = await service.close('user-1', 'ticket-1');

            expect(prisma.ticket.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: { status: 'CLOSED', closedAt: expect.any(Date) },
                }),
            );
            expect(prisma.ticketActivity.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    type: 'STATUS_CHANGED',
                    oldValue: status,
                    newValue: 'CLOSED',
                }),
            });
            expect(notifications.publish).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'TICKET_STATUS_CHANGED' }),
                prisma,
            );
            expect(ticket).toMatchObject({ status: 'CLOSED' });
        },
    );

    it('refuses to close an already closed ticket', async () => {
        const { service, prisma } = createService();
        prisma.ticket.findFirst.mockResolvedValue({
            ...ticketRow,
            status: 'CLOSED',
            closedAt: createdAt,
        });

        await expect(service.close('user-1', 'ticket-1')).rejects.toThrow(
            ConflictException,
        );
        expect(prisma.ticket.update).not.toHaveBeenCalled();
    });
});
