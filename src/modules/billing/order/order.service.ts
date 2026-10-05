import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../../infra/database/prisma.service';
import { OrderStatus } from '../../../generated/prisma/enums';
import { CreateOrderDto } from './dto';
import { OrderEntity } from './entities';

const ORDER_EXPIRY_MS = 30 * 60 * 1000;

@Injectable()
export class OrderService {
    constructor(private readonly prisma: PrismaService) {}

    async create(
        organizationId: string,
        userId: string,
        dto: CreateOrderDto,
    ): Promise<OrderEntity> {
        const plan = await this.prisma.plan.findUnique({
            where: { id: dto.planId },
        });

        if (!plan || !plan.enabled) {
            throw new NotFoundException('Plan not found or disabled');
        }

        if (plan.code === 'FREE') {
            throw new BadRequestException(
                'The FREE plan does not require a purchase',
            );
        }

        const durationDays = dto.durationDays ?? plan.durationDays;

        const order = await this.prisma.order.create({
            data: {
                orderNo: this.generateOrderNo(),
                organizationId,
                planId: plan.id,
                userId,
                amount: plan.price,
                durationDays,
                status: OrderStatus.PENDING,
                expiresAt: new Date(Date.now() + ORDER_EXPIRY_MS),
            },
            include: { plan: true },
        });

        return new OrderEntity(order);
    }

    async findAll(organizationId: string): Promise<OrderEntity[]> {
        const orders = await this.prisma.order.findMany({
            where: { organizationId },
            include: { plan: true },
            orderBy: { createdAt: 'desc' },
        });

        return orders.map((order) => new OrderEntity(order));
    }

    async findOne(orderId: string, userId: string): Promise<OrderEntity> {
        const order = await this.ensureOrderVisible(orderId, userId);
        return new OrderEntity(order);
    }

    async cancel(orderId: string, userId: string): Promise<OrderEntity> {
        const order = await this.ensureOrderVisible(orderId, userId);

        if (order.status !== OrderStatus.PENDING) {
            throw new BadRequestException(
                `Cannot cancel an order with status ${order.status}`,
            );
        }

        const updated = await this.prisma.order.update({
            where: { id: orderId },
            data: {
                status: OrderStatus.CANCELLED,
                cancelledAt: new Date(),
            },
            include: { plan: true },
        });

        return new OrderEntity(updated);
    }

    // -- Helpers ---------------------------------------------------------

    private async ensureOrderVisible(orderId: string, userId: string) {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: { plan: true },
        });

        if (!order) {
            throw new NotFoundException('Order not found');
        }

        const membership = await this.prisma.membership.findUnique({
            where: {
                userId_organizationId: {
                    userId,
                    organizationId: order.organizationId,
                },
            },
        });

        if (!membership) {
            throw new NotFoundException('Order not found');
        }

        return order;
    }

    private generateOrderNo(): string {
        const timestamp = Date.now().toString(36);
        const random = randomBytes(4).toString('hex');
        return `BW${timestamp}${random}`.toUpperCase();
    }
}
