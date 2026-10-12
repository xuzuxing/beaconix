import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { OrderStatus } from '../../../generated/prisma/enums';
import { QueryAdminOrdersDto } from './dto';
import { AdminOrderEntity } from './entities';

/** Relations flattened into every admin order row. */
const orderInclude = {
    plan: true,
    organization: { select: { id: true, name: true, slug: true } },
    user: { select: { id: true, name: true, email: true } },
} as const;

type AdminOrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

@Injectable()
export class AdminOrdersService {
    constructor(private readonly prisma: PrismaService) {}

    /**
     * Explicit cross-tenant order query for SUPER_ADMIN. Unlike the
     * tenant-scoped OrderService, no organizationId filter is forced; every
     * filter is opt-in from the query.
     */
    async findAll(dto: QueryAdminOrdersDto) {
        const {
            organizationId,
            userId,
            planId,
            status,
            orderNo,
            from,
            to,
            page = 1,
            limit = 25,
        } = dto;

        const where: Prisma.OrderWhereInput = {};

        if (organizationId) where.organizationId = organizationId;
        if (userId) where.userId = userId;
        if (planId) where.planId = planId;
        if (status) where.status = status;
        if (orderNo) where.orderNo = orderNo;

        if (from || to) {
            where.createdAt = {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(to) } : {}),
            };
        }

        const [items, total] = await Promise.all([
            this.prisma.order.findMany({
                where,
                include: orderInclude,
                orderBy: { createdAt: 'desc' },
                take: limit,
                skip: (page - 1) * limit,
            }),
            this.prisma.order.count({ where }),
        ]);

        return {
            items: items.map((order) => this.toEntity(order)),
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        };
    }

    async findOne(id: string): Promise<AdminOrderEntity> {
        const order = await this.prisma.order.findUnique({
            where: { id },
            include: orderInclude,
        });

        if (!order) throw new NotFoundException('Order not found');

        return this.toEntity(order);
    }

    /** PENDING -> CANCELLED. */
    cancel(id: string): Promise<AdminOrderEntity> {
        return this.transition(
            id,
            OrderStatus.PENDING,
            OrderStatus.CANCELLED,
            { cancelledAt: new Date() },
            'cancel',
        );
    }

    /**
     * PENDING -> PAID. Marks an order as settled outside the payment channel
     * (manual/offline collection). Deliberately does not activate or renew a
     * subscription — that stays with the payment callback.
     */
    markPaid(id: string): Promise<AdminOrderEntity> {
        return this.transition(
            id,
            OrderStatus.PENDING,
            OrderStatus.PAID,
            { paidAt: new Date() },
            'mark as paid',
        );
    }

    /**
     * PAID -> REFUNDED. Records the refund against the order only; no payment
     * channel refund call is made.
     */
    refund(id: string): Promise<AdminOrderEntity> {
        return this.transition(
            id,
            OrderStatus.PAID,
            OrderStatus.REFUNDED,
            {},
            'refund',
        );
    }

    // -- Helpers ---------------------------------------------------------

    /**
     * Conditional status change: the update only matches while the order is
     * still in `from`, so two concurrent admin actions cannot both win.
     */
    private async transition(
        orderId: string,
        from: OrderStatus,
        to: OrderStatus,
        extra: Prisma.OrderUpdateManyMutationInput,
        action: string,
    ): Promise<AdminOrderEntity> {
        const changed = await this.prisma.order.updateMany({
            where: { id: orderId, status: from },
            data: { status: to, ...extra },
        });

        if (changed.count === 0) {
            const existing = await this.prisma.order.findUnique({
                where: { id: orderId },
                select: { status: true },
            });

            if (!existing) throw new NotFoundException('Order not found');
            throw new BadRequestException(
                `Cannot ${action} an order with status ${existing.status}`,
            );
        }

        return this.findOne(orderId);
    }

    private toEntity(order: AdminOrderRow): AdminOrderEntity {
        return new AdminOrderEntity({
            id: order.id,
            orderNo: order.orderNo,
            organizationId: order.organizationId,
            planId: order.planId,
            userId: order.userId,
            amount: order.amount,
            currency: order.currency,
            durationDays: order.durationDays,
            status: order.status,
            paidAt: order.paidAt,
            cancelledAt: order.cancelledAt,
            expiresAt: order.expiresAt,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
            plan: order.plan,
            organization: order.organization,
            user: order.user,
        });
    }
}
