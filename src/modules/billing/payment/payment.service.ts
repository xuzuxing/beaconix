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
} from '../../../generated/prisma/enums';
import { NotificationsService } from '../../notifications/notifications.service';
import type { OrderModel } from '../../../generated/prisma/models';
import { CreatePaymentDto } from './dto';
import { PaymentProviderFactory } from './payment-provider.factory';
import type {
    PaymentCallbackHeaders,
    PaymentProviderPayParams,
} from './payment-provider.interface';
import { settlePaidOrder } from './payment-settlement';

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

        if (channel === PaymentChannel.WECHAT_VIRTUAL) {
            // 虚拟支付的签名与回调形态完全不同，由 `WechatVirtualPaymentService`
            // 处理；这里拦住是为了避免调用方以为「传个 channel 就行」。
            throw new BadRequestException(
                'The WECHAT_VIRTUAL channel is served by the mini-program virtual payment flow',
            );
        }

        const openid = dto.openid?.trim();

        if (!openid) {
            throw new BadRequestException(
                'openid is required for the WECHAT (JSAPI) channel',
            );
        }

        const provider = this.paymentProviderFactory.get(channel);

        const params = await provider.createPayment({
            outTradeNo: order.orderNo,
            totalFee: order.amount,
            payerId: openid,
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

            await settlePaidOrder(tx, {
                order: payment.order,
                paymentId: payment.id,
                notifications: this.notifications,
            });
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
    async assertChannelSwitchable(
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

    /**
     * 订单可支付校验：存在、属于该用户所在组织、仍为 PENDING、未过期。
     *
     * 公开是为了让虚拟支付通道复用同一套规则（它不走 `PaymentProvider`）。
     */
    async ensureOrderPayable(
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
}
