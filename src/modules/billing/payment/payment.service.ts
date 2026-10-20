import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service';
import { toIsoString } from '../../../common/utils/date.util';
import type { Prisma } from '../../../generated/prisma/client';
import {
    OrderStatus,
    PaymentChannel,
    PaymentStatus,
    SubscriptionStatus,
    NotificationType,
} from '../../../generated/prisma/enums';
import { NotificationsService } from '../../notifications/notifications.service';
import { ADMIN_ROLES } from '../../notifications/notification-event';
import type { OrderModel } from '../../../generated/prisma/models';
import { CreatePaymentDto } from './dto';
import { PaymentProviderFactory } from './payment-provider.factory';
import type {
    PaymentCallbackHeaders,
    PaymentProviderPayParams,
} from './payment-provider.interface';

type OrderForPayment = OrderModel;

/** WeChat Pay V3 callback acknowledgement body (`code` + `message`). */
export interface PaymentCallbackResponse {
    code: 'SUCCESS' | 'FAIL';
    message?: string;
}

@Injectable()
export class PaymentService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly paymentProviderFactory: PaymentProviderFactory,
        private readonly notifications: NotificationsService,
    ) {}

    async createPayment(
        orderId: string,
        userId: string,
        dto: CreatePaymentDto,
    ) {
        const order = await this.ensureOrderPayable(orderId, userId);
        const channel = dto.channel ?? PaymentChannel.WECHAT;
        await this.assertChannelSwitchable(order.id, channel);
        const provider = this.paymentProviderFactory.get(channel);

        const params = await provider.createPayment({
            outTradeNo: order.orderNo,
            totalFee: order.amount,
            payerId: dto.openid,
            body: `Beaconix plan order ${order.orderNo}`,
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
    async handleWechatCallback(
        rawBody: string,
        signature: string,
        headers?: PaymentCallbackHeaders,
    ): Promise<PaymentCallbackResponse> {
        return this.handleCallback(
            PaymentChannel.WECHAT,
            rawBody,
            signature,
            headers,
        );
    }

    /** Channel-agnostic callback processing through the provider factory. */
    async handleCallback(
        channel: PaymentChannel,
        rawBody: string,
        signature: string,
        headers?: PaymentCallbackHeaders,
    ): Promise<PaymentCallbackResponse> {
        const provider = this.paymentProviderFactory.get(channel);
        const callback = await provider.verifyCallback(
            rawBody,
            signature,
            headers,
        );

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
            return { code: 'SUCCESS', message: '成功' };
        }

        await this.prisma.$transaction(async (tx) => {
            // Normalise an empty `transaction_id` to NULL: the column is
            // `@unique`, and an empty string is still unique-indexed, so a
            // second empty callback would collide (P2002) and 500 the request.
            const transactionId = callback.transaction_id?.trim() || null;

            // Re-check and update conditionally inside the transaction: WeChat
            // may deliver the same callback concurrently, and the unique
            // `transactionId` would otherwise throw P2002 on the second update.
            const updated = await tx.payment.updateMany({
                where: {
                    id: payment.id,
                    status: { not: PaymentStatus.SUCCESS },
                },
                data: {
                    status: PaymentStatus.SUCCESS,
                    transactionId,
                    paidAt: new Date(),
                    rawCallback: callback as Prisma.InputJsonValue,
                },
            });

            // A concurrent callback already settled this payment — nothing to do.
            if (updated.count === 0) {
                return;
            }

            await tx.order.update({
                where: { id: payment.orderId },
                data: { status: OrderStatus.PAID, paidAt: new Date() },
            });

            // Serialize renewals and expiry sweeps for this tenant.
            await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${payment.order.organizationId} FOR UPDATE`;
            const activation = await this.activateSubscription(
                tx,
                payment.order,
            );
            const recipients = [
                payment.order.userId,
                ...(await this.notifications.organizationRecipients(
                    payment.order.organizationId,
                    tx,
                    ADMIN_ROLES,
                )),
            ];
            await this.notifications.publish(
                {
                    eventKey: `payment-succeeded:${payment.id}`,
                    type: NotificationType.PAYMENT_SUCCEEDED,
                    accessScope: 'ORGANIZATION',
                    title: 'Payment received',
                    body: 'Your subscription payment has been confirmed.',
                    organizationId: payment.order.organizationId,
                    recipients,
                    includeActor: true,
                    email: true,
                    resourceType: 'Order',
                    resourceId: payment.orderId,
                },
                tx,
            );
            await this.notifications.publish(
                {
                    eventKey: `subscription-${activation.renewed ? 'renewed' : 'activated'}:${payment.orderId}`,
                    type: activation.renewed
                        ? NotificationType.SUBSCRIPTION_RENEWED
                        : NotificationType.SUBSCRIPTION_ACTIVATED,
                    accessScope: 'ORGANIZATION',
                    title: activation.renewed
                        ? 'Subscription renewed'
                        : 'Subscription activated',
                    body: `The subscription is valid until ${toIsoString(activation.expiresAt)}.`,
                    organizationId: payment.order.organizationId,
                    recipients,
                    includeActor: true,
                    email: true,
                    resourceType: 'Subscription',
                    resourceId: activation.id,
                    meta: {
                        expiresAt: toIsoString(activation.expiresAt),
                        planId: payment.order.planId,
                    },
                },
                tx,
            );
        });

        return { code: 'SUCCESS', message: '成功' };
    }

    // -- Helpers ---------------------------------------------------------

    private extractPrepayId(params: PaymentProviderPayParams): string {
        const value = params['package'] ?? params['prepayId'] ?? '';
        return typeof value === 'string' ? value : JSON.stringify(value);
    }

    /**
     * 一笔订单只有一条支付记录（`Payment.orderId` 是唯一键），换渠道发起会覆盖它。
     * 已成功的记录绝不能覆盖：覆盖后原渠道的回调按 `channel` 就查不到这一条，
     * 幂等与对账都会断线（用户扣了钱、订单却不激活），所以直接拒绝。
     */
    private async assertChannelSwitchable(
        orderId: string,
        channel: PaymentChannel,
    ): Promise<void> {
        const existing = await this.prisma.payment.findUnique({
            where: { orderId },
            select: { channel: true, status: true },
        });

        if (!existing || existing.status !== PaymentStatus.SUCCESS) return;

        // 取成 string：枚举当前只有 WECHAT，`!==` 的 false 分支会被收窄成 never
        const paidChannel: string = existing.channel;

        throw new BadRequestException(
            paidChannel === channel
                ? 'Order is already paid'
                : `Order already paid via ${paidChannel}`,
        );
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

    /**
     * Applies a paid order to the subscription stack:
     *
     * - same plan, still valid → extend it (renewal);
     * - higher plan → freeze every lower active subscription (remaining days are
     *   kept and restored once the higher plan lapses), new plan starts now;
     * - same or lower plan while one is active → queue behind it
     *   (`startsAt` = current expiry), which `EffectivePlanService` already
     *   honours through its `startsAt <= now` filter.
     */
    private async activateSubscription(
        tx: Prisma.TransactionClient,
        order: OrderForPayment,
    ): Promise<{ id: string; expiresAt: Date; renewed: boolean }> {
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
            const expiresAt = new Date(
                existing.expiresAt.getTime() + order.durationDays * dayMs,
            );
            await tx.subscription.update({
                where: { id: existing.id },
                data: { expiresAt },
            });
            return { id: existing.id, expiresAt, renewed: true };
        }

        const [plan, effective] = await Promise.all([
            tx.plan.findUniqueOrThrow({
                where: { id: order.planId },
                select: { sortOrder: true },
            }),
            tx.subscription.findFirst({
                where: {
                    organizationId: order.organizationId,
                    status: SubscriptionStatus.ACTIVE,
                    startsAt: { lte: now },
                    expiresAt: { gt: now },
                },
                include: { plan: { select: { sortOrder: true } } },
                orderBy: { plan: { sortOrder: 'desc' } },
            }),
        ]);

        let startsAt = now;

        if (effective) {
            if (plan.sortOrder > effective.plan.sortOrder) {
                await this.pauseLowerSubscriptions(
                    tx,
                    order.organizationId,
                    plan.sortOrder,
                    now,
                );
            } else {
                // Same or lower tier: take effect when the current one lapses.
                startsAt = effective.expiresAt;
            }
        }

        const expiresAt = new Date(
            startsAt.getTime() + order.durationDays * dayMs,
        );
        const subscription = await tx.subscription.create({
            data: {
                organizationId: order.organizationId,
                planId: order.planId,
                status: SubscriptionStatus.ACTIVE,
                startsAt,
                expiresAt,
                orderId: order.id,
            },
        });
        return { id: subscription.id, expiresAt, renewed: false };
    }

    /**
     * Freezes the remaining days of every active subscription below
     * `sortOrder`. At least one day is kept so a nearly-expired plan never
     * loses its last slice to rounding.
     */
    private async pauseLowerSubscriptions(
        tx: Prisma.TransactionClient,
        organizationId: string,
        sortOrder: number,
        now: Date,
    ): Promise<void> {
        const dayMs = 24 * 60 * 60 * 1000;
        const lower = await tx.subscription.findMany({
            where: {
                organizationId,
                status: SubscriptionStatus.ACTIVE,
                startsAt: { lte: now },
                expiresAt: { gt: now },
                plan: { sortOrder: { lt: sortOrder } },
            },
            select: { id: true, expiresAt: true },
        });

        for (const subscription of lower) {
            const pausedRemainingDays = Math.max(
                1,
                Math.ceil(
                    (subscription.expiresAt.getTime() - now.getTime()) / dayMs,
                ),
            );

            await tx.subscription.update({
                where: { id: subscription.id },
                data: {
                    status: SubscriptionStatus.PAUSED,
                    pausedAt: now,
                    pausedRemainingDays,
                },
            });
        }
    }
}
