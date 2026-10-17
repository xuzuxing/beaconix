import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AdminTicketCategoriesService } from './admin-ticket-categories.service';
import { TicketCategoriesService } from '../../tickets/ticket-categories.service';
import type { PrismaService } from '../../../infra/database/prisma.service';

const categoryRow = {
    id: 'cat-1',
    name: 'Billing',
    description: null,
    sortOrder: 0,
    isActive: true,
    createdAt: new Date('2026-10-17T08:00:00.000Z'),
    updatedAt: new Date('2026-10-17T08:00:00.000Z'),
};

function createService() {
    const prisma = {
        ticketCategory: {
            create: jest.fn(),
            update: jest.fn(),
            findUnique: jest.fn(),
            findMany: jest.fn(),
            delete: jest.fn(),
        },
        ticket: { count: jest.fn().mockResolvedValue(0) },
    };

    const service = new AdminTicketCategoriesService(
        prisma as unknown as PrismaService,
    );

    return { service, prisma };
}

describe('AdminTicketCategoriesService.create', () => {
    it('creates a category with defaults', async () => {
        const { service, prisma } = createService();
        prisma.ticketCategory.create.mockResolvedValue(categoryRow);

        const category = await service.create({ name: 'Billing' });

        expect(prisma.ticketCategory.create).toHaveBeenCalledWith({
            data: {
                name: 'Billing',
                description: null,
                sortOrder: 0,
                isActive: true,
            },
        });
        expect(category).toMatchObject({ id: 'cat-1', name: 'Billing' });
    });

    it('maps a duplicate name to 409', async () => {
        const { service, prisma } = createService();
        prisma.ticketCategory.create.mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('unique', {
                code: 'P2002',
                clientVersion: 'test',
            }),
        );

        await expect(service.create({ name: 'Billing' })).rejects.toThrow(
            ConflictException,
        );
    });
});

describe('AdminTicketCategoriesService.update', () => {
    it('throws 404 for an unknown category', async () => {
        const { service, prisma } = createService();
        prisma.ticketCategory.findUnique.mockResolvedValue(null);

        await expect(
            service.update('cat-9', { name: 'Renamed' }),
        ).rejects.toThrow(NotFoundException);
        expect(prisma.ticketCategory.update).not.toHaveBeenCalled();
    });

    it('only writes the provided fields', async () => {
        const { service, prisma } = createService();
        prisma.ticketCategory.findUnique.mockResolvedValue({ id: 'cat-1' });
        prisma.ticketCategory.update.mockResolvedValue({
            ...categoryRow,
            isActive: false,
        });

        const category = await service.update('cat-1', { isActive: false });

        expect(prisma.ticketCategory.update).toHaveBeenCalledWith({
            where: { id: 'cat-1' },
            data: { isActive: false },
        });
        expect(category).toMatchObject({ isActive: false });
    });

    it('maps a duplicate rename to 409', async () => {
        const { service, prisma } = createService();
        prisma.ticketCategory.findUnique.mockResolvedValue({ id: 'cat-1' });
        prisma.ticketCategory.update.mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('unique', {
                code: 'P2002',
                clientVersion: 'test',
            }),
        );

        await expect(
            service.update('cat-1', { name: 'Billing' }),
        ).rejects.toThrow(ConflictException);
    });
});

describe('AdminTicketCategoriesService.remove', () => {
    it('refuses to delete a referenced category', async () => {
        const { service, prisma } = createService();
        prisma.ticketCategory.findUnique.mockResolvedValue({ id: 'cat-1' });
        prisma.ticket.count.mockResolvedValue(3);

        await expect(service.remove('cat-1')).rejects.toThrow(
            ConflictException,
        );
        expect(prisma.ticketCategory.delete).not.toHaveBeenCalled();
    });

    it('hard-deletes an unused category', async () => {
        const { service, prisma } = createService();
        prisma.ticketCategory.findUnique.mockResolvedValue({ id: 'cat-1' });

        await service.remove('cat-1');

        expect(prisma.ticketCategory.delete).toHaveBeenCalledWith({
            where: { id: 'cat-1' },
        });
    });
});

describe('TicketCategoriesService.listActive', () => {
    it('stops serving deactivated categories to end users', async () => {
        const { prisma } = createService();
        prisma.ticketCategory.findMany.mockResolvedValue([categoryRow]);
        const service = new TicketCategoriesService(
            prisma as unknown as PrismaService,
        );

        const categories = await service.listActive();

        expect(prisma.ticketCategory.findMany).toHaveBeenCalledWith({
            where: { isActive: true },
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        });
        expect(categories).toEqual([
            expect.objectContaining({ id: 'cat-1', isActive: true }),
        ]);
    });
});
