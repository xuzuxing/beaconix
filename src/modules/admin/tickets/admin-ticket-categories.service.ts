import {
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../infra/database/prisma.service';
import { TicketCategoryEntity } from '../../tickets/entities';
import { CreateTicketCategoryDto, UpdateTicketCategoryDto } from './dto';

/** Platform-wide category dictionary. Categories are shared by all tenants. */
@Injectable()
export class AdminTicketCategoriesService {
    constructor(private readonly prisma: PrismaService) {}

    async create(dto: CreateTicketCategoryDto): Promise<TicketCategoryEntity> {
        try {
            const category = await this.prisma.ticketCategory.create({
                data: {
                    name: dto.name,
                    description: dto.description ?? null,
                    sortOrder: dto.sortOrder ?? 0,
                    isActive: dto.isActive ?? true,
                },
            });
            return new TicketCategoryEntity(category);
        } catch (error) {
            this.rethrowUnique(error);
            throw error;
        }
    }

    async update(
        categoryId: string,
        dto: UpdateTicketCategoryDto,
    ): Promise<TicketCategoryEntity> {
        await this.requireCategory(categoryId);
        try {
            const category = await this.prisma.ticketCategory.update({
                where: { id: categoryId },
                data: {
                    ...(dto.name !== undefined ? { name: dto.name } : {}),
                    ...(dto.description !== undefined
                        ? { description: dto.description }
                        : {}),
                    ...(dto.sortOrder !== undefined
                        ? { sortOrder: dto.sortOrder }
                        : {}),
                    ...(dto.isActive !== undefined
                        ? { isActive: dto.isActive }
                        : {}),
                },
            });
            return new TicketCategoryEntity(category);
        } catch (error) {
            this.rethrowUnique(error);
            throw error;
        }
    }

    /**
     * Hard-deletes an unused category. A category referenced by any ticket
     * (including soft-deleted ones) must be deactivated instead so history
     * stays readable.
     */
    async remove(categoryId: string): Promise<void> {
        await this.requireCategory(categoryId);
        const referenced = await this.prisma.ticket.count({
            where: { categoryId },
        });
        if (referenced) {
            throw new ConflictException({
                code: 'CATEGORY_IN_USE',
                message:
                    'Category is referenced by tickets; deactivate it instead',
            });
        }
        await this.prisma.ticketCategory.delete({ where: { id: categoryId } });
    }

    private async requireCategory(categoryId: string) {
        const category = await this.prisma.ticketCategory.findUnique({
            where: { id: categoryId },
            select: { id: true },
        });
        if (!category) throw new NotFoundException('Ticket category not found');
        return category;
    }

    private rethrowUnique(error: unknown): void {
        if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
        ) {
            throw new ConflictException({
                code: 'CATEGORY_NAME_TAKEN',
                message: 'A category with this name already exists',
            });
        }
    }
}
