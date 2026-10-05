import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import {
    OrderStatus,
    PaymentChannel,
    PaymentStatus,
    SubscriptionStatus,
} from '../../../generated/prisma/enums';
import type { OrderModel } from '../../../generated/prisma/models';
import { CreatePaymentDto } from './dto';
import { PaymentProviderFactory } from './payment-provider.factory';
import type { PaymentProviderPayParams } from './payment-provider.interface';

type OrderForPayment = OrderModel;

@Injectable()
export class PaymentService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly paymentProviderFactory: PaymentProviderFactory,
    ) {}

    async createPayment(
        orderId: string,
        userId: string,
        dto: CreatePaymentDto,
    ) {
        const order = await this.ensureOrderPayable(orderId, userId);
        const channel = dto.channel ?? PaymentChannel.WECHAT;
        const provider = this.paymentProviderFactory.get(channel);

        const params = await provider.createPayment({
            outTradeNo: order.orderNo,
            totalFee: order.amount,
            payerId: dto.openid,
            body: `Beacon plan order ${order.orderNo}`,
        });

        await this.prisma.payment.upsert({
            where: { orderId: order.id },
            create: {
                orderId: order.id,
                channel,
                prepayId: this.extractPrepayId(params),
                amount: order.amount,
                status: PaymentStatus.PENDING,
            },
            update: {
                channel,
                prepayId: this.extractPrepayId(params),
            },
        });

        return params;
    }

    /** Idempotent WeChat callback: a repeated SUCCESS callback is a no-op. */
    async handleWechatCallback(rawBody: string, signature: string) {
        return this.handleCallback(PaymentChannel.WECHAT, rawBody, signature);
    }

    /** Channel-agnostic callback processing through the provider factory. */
    async handleCallback(
        channel: PaymentChannel,
        rawBody: string,
        signature: string,
    ) {
        const provider = this.paymentProviderFactory.get(channel);
        const callback = await provider.verifyCallback(rawBody, signature);

        if (callback.trade_state !== 'SUCCESS') {
            return { code: 'FAIL', message: 'trade_state is not SUCCESS' };
        }

        const payment = await this.prisma.payment.findFirst({
            where: {
                channel,
                order: { orderNo: callback.out_trade_no },
            },
            include: { order: true },
        });

        if (!payment) {
            return { code: 'FAIL', message: 'Payment not found' };
        }

        if (payment.status === PaymentStatus.SUCCESS) {
            return { code: 'SUCCESS' };
        }

        await this.prisma.$transaction(async (tx) => {
            await tx.payment.update({
                where: { id: payment.id },
                data: {
                    status: PaymentStatus.SUCCESS,
                    transactionId: callback.transaction_id,
                    paidAt: new Date(),
                    rawCallback: callback as Prisma.InputJsonValue,
                },
            });

            await tx.order.update({
                where: { id: payment.orderId },
                data: { status: OrderStatus.PAID, paidAt: new Date() },
            });

            await this.activateSubscription(tx, payment.order);
        });

        return { code: 'SUCCESS' };
    }

    // -- Helpers ---------------------------------------------------------

    private extractPrepayId(params: PaymentProviderPayParams): string {
        const value = params['package'] ?? params['prepayId'] ?? '';
        return typeof value === 'string' ? value : JSON.stringify(value);
    }

    private async ensureOrderPayable(
        orderId: string,
        userId: string,
    ): Promise<OrderForPayment> {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
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

        if (order.status !== OrderStatus.PENDING) {
            throw new BadRequestException(
                `Cannot pay an order with status ${order.status}`,
            );
        }

        if (order.expiresAt < new Date()) {
            throw new BadRequestException('Order has expired');
        }

        return order;
    }

    private async activateSubscription(
        tx: Prisma.TransactionClient,
        order: OrderForPayment,
    ): Promise<void> {
        const now = new Date();
        const dayMs = 24 * 60 * 60 * 1000;

        const existing = await tx.subscription.findFirst({
            where: {
                organizationId: order.organizationId,
                planId: order.planId,
                status: SubscriptionStatus.ACTIVE,
                expiresAt: { gt: now },
            },
        });

        if (existing) {
            await tx.subscription.update({
                where: { id: existing.id },
                data: {
                    expiresAt: new Date(
                        existing.expiresAt.getTime() +
                            order.durationDays * dayMs,
                    ),
                },
            });
            return;
        }

        await tx.subscription.create({
            data: {
                organizationId: order.organizationId,
                planId: order.planId,
                status: SubscriptionStatus.ACTIVE,
                startsAt: now,
                expiresAt: new Date(now.getTime() + order.durationDays * dayMs),
                orderId: order.id,
            },
        });
    }
}
