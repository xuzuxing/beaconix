import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { TicketCategoryEntity } from './entities';

/** Read-only category list for the ticket submission form. */
@Injectable()
export class TicketCategoriesService {
    constructor(private readonly prisma: PrismaService) {}

    async listActive(): Promise<TicketCategoryEntity[]> {
        const categories = await this.prisma.ticketCategory.findMany({
            where: { isActive: true },
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        });
        return categories.map((category) => new TicketCategoryEntity(category));
    }
}
