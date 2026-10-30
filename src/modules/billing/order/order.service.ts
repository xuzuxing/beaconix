import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../../infra/database/prisma.service';
import { OrderStatus, PlanCycle } from '../../../generated/prisma/enums';
import { CreateOrderDto } from './dto';
import { OrderEntity } from './entities';
import { PaymentService } from '../payment/payment.service';

const ORDER_EXPIRY_MS = 30 * 60 * 1000;

@Injectable()
export class OrderService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly payments: PaymentService,
    ) {}

    async create(
        organizationId: string,
        userId: string,
        dto: CreateOrderDto,
    ): Promise<OrderEntity> {
        const plan = await this.prisma.plan.findUnique({
            where: { id: dto.planId },
            include: {
                terms: {
                    where: { enabled: true },
                    orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }],
                },
            },
        });

        if (!plan) {
            throw new NotFoundException('Plan not found');
        }

        if (!plan.enabled) {
            throw new BadRequestException({
                code: 'PLAN_NOT_PURCHASABLE',
                message: 'plan is not purchasable',
            });
        }

        if (plan.code === 'FREE') {
            throw new BadRequestException({
                code: 'FREE_PLAN_NOT_PURCHASABLE',
                message: 'The FREE plan does not require a purchase',
            });
        }

        const term = this.resolveTerm(plan.terms, dto.cycle);

        const order = await this.prisma.order.create({
            data: {
                orderNo: this.generateOrderNo(),
                organizationId,
                planId: plan.id,
                userId,
                amount: term.price,
                durationDays: term.durationDays,
                cycle: term.cycle,
                termId: term.id,
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

        if (!(await this.payments.cancelOrder(orderId))) {
            throw new BadRequestException('Order is no longer pending');
        }
        return this.findOne(orderId, userId);
    }

    // -- Helpers ---------------------------------------------------------

    /**
     * Picks the cycle the buyer asked for, or the cheapest enabled one when
     * they did not choose. Price and duration always come from the stored term,
     * never from the request, so a client cannot buy ten years for the price of
     * one month.
     */
    private resolveTerm<T extends { cycle: PlanCycle }>(
        terms: T[],
        cycle?: PlanCycle,
    ): T {
        if (terms.length === 0) {
            throw new BadRequestException({
                code: 'PLAN_NOT_PURCHASABLE',
                message: 'plan is not purchasable',
            });
        }

        if (!cycle) return terms[0];

        const term = terms.find((candidate) => candidate.cycle === cycle);

        if (!term) {
            throw new BadRequestException({
                code: 'PLAN_CYCLE_NOT_AVAILABLE',
                message: `plan does not offer the ${cycle} cycle`,
            });
        }

        return term;
    }

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
