import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import {
    NotificationType,
    OrderStatus,
    PaymentChannel,
    PaymentStatus,
    RefundStatus,
    RefundType,
    SubscriptionStatus,
} from '../../../generated/prisma/enums';
import type {
    OrderModel,
    PaymentModel,
    RefundModel,
} from '../../../generated/prisma/models';
import { PrismaService } from '../../../infra/database/prisma.service';
import { EffectivePlanService } from '../../../shared/subscription/effective-plan.service';
import { ADMIN_ROLES } from '../../notifications/notification-event';
import { NotificationsService } from '../../notifications/notifications.service';
import { PaymentProviderFactory } from '../payment/payment-provider.factory';
import type {
    PaymentCallbackHeaders,
    PaymentProviderRefundResult,
} from '../payment/payment-provider.interface';
import {
    RefundConfigService,
    type RefundRuntimeConfig,
} from './refund-config.service';
import { generateRefundNo } from './refund-number.util';
import { DAY_MS, quoteRefund, type RefundQuote } from './refund-policy';

const { PENDING, PROCESSING, SUCCESS, FAILED, CLOSED } = RefundStatus;

export interface RefundQuoteResult {
    order: OrderModel;
    quote: RefundQuote;
    config: RefundRuntimeConfig;
}

export interface CreateRefundInput {
    orderId: string;
    /** 默认按政策自动判定；`MANUAL` 时必须给 `amount`。 */
    type?: RefundType;
    /** 人工指定金额（分），仅 `MANUAL` 生效。 */
    amount?: number;
    reason?: string;
    requestedBy?: string;
    /**
     * 发起人的用户 id。用户自助发起时必传：既用于校验组织归属，
     * 也决定是否受 `billing.refund.userSelfService` 约束。
     */
    actorUserId?: string;
    /**
     * `USER` = 用户自助申请（按 `autoApproveLimit` 决定是否自动执行）；
     * `ADMIN`（默认）= 后台发起，直接提交渠道。
     */
    origin?: 'USER' | 'ADMIN';
}

/** 用户端可见的退款视图：裁掉渠道原始报文与内部审批字段。 */
export interface UserRefundView {
    id: string;
    refundNo: string;
    status: RefundStatus;
    type: RefundType;
    amount: number;
    settledAmount: number | null;
    policyCode: string | null;
    usedDays: number | null;
    remainingDays: number | null;
    reason: string | null;
    failureReason: string | null;
    refundedAt: Date | null;
    createdAt: Date;
}

/**
 * 退款编排：政策试算 → 建单 → 提交渠道 → 幂等结算 → 回收订阅。
 *
 * 三条不变量（都靠条件更新与唯一约束保证，不靠「先查后写」）：
 * 1. 一单一退：同单最多一条 `SUCCESS`，在途（PENDING/PROCESSING）最多一条；
 * 2. 同一条退款重复回调只结算一次：`updateMany where status != SUCCESS`；
 * 3. 累计退款不超过订单金额：`refundedAmount` 与上限校验双保险。
 */
@Injectable()
export class RefundService {
    private readonly logger = new Logger(RefundService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly providers: PaymentProviderFactory,
        private readonly notifications: NotificationsService,
        private readonly effectivePlan: EffectivePlanService,
        private readonly refundConfig: RefundConfigService,
    ) {}

    /**
     * 政策试算：用户/后台都能调，不改任何状态。
     *
     * 传 `actorUserId` 表示用户端调用，会校验「订单属于该用户所在组织」；
     * 后台（SUPER_ADMIN）不传，可跨租户试算。
     */
    async quote(
        orderId: string,
        now = new Date(),
        actorUserId?: string,
    ): Promise<RefundQuoteResult> {
        const order = await this.requireOrder(orderId);

        if (actorUserId) {
            await this.assertMembership(order.organizationId, actorUserId);
        }

        const [ownSegment, config] = await Promise.all([
            this.prisma.subscription.findFirst({
                where: { orderId: order.id },
                select: { id: true },
            }),
            this.refundConfig.config(),
        ]);

        const quote = quoteRefund(
            {
                amount: order.amount,
                durationDays: order.durationDays,
                paidAt: order.paidAt,
                serviceStartsAt: order.serviceStartsAt,
                serviceEndsAt: order.serviceEndsAt,
                refundedAmount: order.refundedAmount,
                hasOwnSubscription: Boolean(ownSegment),
            },
            now,
            config,
        );

        return { order, quote, config };
    }

    /**
     * 创建并发起退款。
     *
     * 渠道调用不放在事务里：网络请求可长可短，长事务会锁住租户行；建单先落
     * `PENDING`，渠道返回后再推进状态，失败也只是把记录标 `FAILED`。
     */
    async create(input: CreateRefundInput): Promise<RefundModel> {
        const origin = input.origin ?? 'ADMIN';
        const { order, quote, config } = await this.quote(
            input.orderId,
            new Date(),
            origin === 'USER' ? input.actorUserId : undefined,
        );

        if (!config.enabled) {
            throw new BadRequestException('Refunds are disabled');
        }

        // 用户自助是灰度能力：后台没打开开关时，用户端一个都不能提交。
        if (origin === 'USER' && !config.userSelfService) {
            throw new ForbiddenException('Self-service refunds are disabled');
        }

        if (order.status !== OrderStatus.PAID) {
            throw new BadRequestException(
                `Cannot refund an order with status ${order.status}`,
            );
        }

        const payment = await this.prisma.payment.findUnique({
            where: { orderId: order.id },
        });

        if (!payment || payment.status !== PaymentStatus.SUCCESS) {
            throw new BadRequestException(
                'Order has no successful payment to refund',
            );
        }

        // 虚拟支付走自己的退款任务（`/xpay/refund_order`），由
        // `WechatVirtualPaymentService` 实现 `RefundProvider` 后统一调用。
        await this.assertNothingInFlight(order.id);

        const manual = input.type === RefundType.MANUAL;
        const amount = manual
            ? this.manualAmount(input.amount, quote)
            : quote.amount;

        if (!manual && !quote.eligible) {
            throw new BadRequestException(
                quote.reason ?? 'This order is not refundable',
            );
        }

        const refund = await this.prisma.refund.create({
            data: {
                refundNo: generateRefundNo(),
                orderId: order.id,
                organizationId: order.organizationId,
                channel: payment.channel,
                type: manual ? RefundType.MANUAL : quote.type,
                status: PENDING,
                amount,
                policyCode: manual ? 'MANUAL' : quote.policyCode,
                // 折算快照即使人工退款也存，回收订阅时用它算回退天数
                usedDays: quote.usedDays,
                remainingDays: quote.remainingDays,
                reason: input.reason?.trim() || null,
                requestedBy: input.requestedBy ?? null,
            },
        });

        // 后台发起直接执行；用户自助只在金额不超过自动通过阈值时立即执行，
        // 否则停在 PENDING 等运营审批（阈值默认 0 = 全部人工）。
        const autoApprove =
            origin === 'ADMIN' ||
            (config.autoApproveLimit > 0 && amount <= config.autoApproveLimit);

        if (!autoApprove) {
            this.logger.log(
                `Refund ${refund.refundNo} is awaiting approval (${amount} cents)`,
            );

            return refund;
        }

        return this.submit(refund, order, payment);
    }

    /**
     * 审批通过：把停在 `PENDING` 的用户申请提交到渠道。
     *
     * 审批本身不改订阅、不改订单，一切等渠道结果走 `markSuccess`。
     */
    async approve(
        refundId: string,
        adminUserId?: string,
    ): Promise<RefundModel> {
        const refund = await this.prisma.refund.findUnique({
            where: { id: refundId },
        });

        if (!refund) throw new NotFoundException('Refund not found');
        if (refund.status !== PENDING) {
            throw new BadRequestException(
                'Only a pending refund can be approved',
            );
        }

        const [order, payment] = await Promise.all([
            this.prisma.order.findUniqueOrThrow({
                where: { id: refund.orderId },
            }),
            this.prisma.payment.findUnique({
                where: { orderId: refund.orderId },
            }),
        ]);

        if (!payment) {
            throw new BadRequestException('Order has no payment to refund');
        }

        const approved = await this.prisma.refund.update({
            where: { id: refund.id },
            data: { approvedBy: adminUserId ?? null },
        });

        return this.submit(approved, order, payment);
    }

    /** 渠道已受理但还没终态（微信常见）。 */
    async markProcessing(
        refundId: string,
        result: PaymentProviderRefundResult,
    ): Promise<RefundModel> {
        await this.prisma.refund.updateMany({
            where: { id: refundId, status: { in: [PENDING, PROCESSING] } },
            data: {
                status: PROCESSING,
                channelRefundId: result.channelRefundId ?? undefined,
                rawResponse: toJson(result.raw),
            },
        });

        return this.prisma.refund.findUniqueOrThrow({
            where: { id: refundId },
        });
    }

    async markFailed(refundId: string, reason: string): Promise<RefundModel> {
        await this.prisma.refund.updateMany({
            where: { id: refundId, status: { in: [PENDING, PROCESSING] } },
            data: { status: FAILED, failureReason: reason.slice(0, 500) },
        });

        return this.prisma.refund.findUniqueOrThrow({
            where: { id: refundId },
        });
    }

    /**
     * 落账：钱确实退回去了。
     *
     * 幂等靠 `updateMany where status != SUCCESS`：并发回调（微信退款通知 +
     * 轮询）只会有一个把记录推进 SUCCESS，另一个 count = 0 直接返回。
     */
    async markSuccess(
        refundId: string,
        result: PaymentProviderRefundResult = { status: 'SUCCESS' },
    ): Promise<RefundModel> {
        const refund = await this.prisma.refund.findUnique({
            where: { id: refundId },
        });

        if (!refund) throw new NotFoundException('Refund not found');
        if (refund.status === SUCCESS) return refund;

        await this.prisma.$transaction(async (tx) => {
            // 与支付回调、订阅过期扫描共用同一把租户锁，避免订阅栈并发错乱。
            await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${refund.organizationId} FOR UPDATE`;

            const updated = await tx.refund.updateMany({
                where: { id: refundId, status: { not: SUCCESS } },
                data: {
                    status: SUCCESS,
                    settledAmount: refund.amount,
                    channelRefundId:
                        result.channelRefundId ?? refund.channelRefundId,
                    rawResponse: toJson(result.raw),
                    refundedAt: new Date(),
                    failureReason: null,
                },
            });

            if (updated.count === 0) return;

            const order = await tx.order.findUniqueOrThrow({
                where: { id: refund.orderId },
            });

            await tx.order.update({
                where: { id: order.id },
                data: {
                    // 一单一退：退过就不再允许再次支付
                    status: OrderStatus.REFUNDED,
                    refundedAmount: { increment: refund.amount },
                },
            });

            await tx.payment.updateMany({
                where: { orderId: order.id },
                data: {
                    status: PaymentStatus.REFUNDED,
                    refundedAmount: { increment: refund.amount },
                },
            });

            await this.reclaimSubscription(tx, refund, order);

            // 高档订阅被退款终止后，被压住的低档订阅要立刻放出来，
            // 否则用户从「有权益」直接掉到「无权益」。
            await this.effectivePlan.getEffectivePlanInTransaction(
                order.organizationId,
                tx,
            );

            await this.publishRefunded(tx, refund, order);
        });

        return this.prisma.refund.findUniqueOrThrow({
            where: { id: refundId },
        });
    }

    /**
     * 微信退款结果通知入口。
     *
     * 应答约定与交易回调一致：验签/解析失败回 FAIL 让微信重试；未知退款单
     * 也回 FAIL —— 多半是本地记录丢失，需要人工介入而不是静默吞掉。
     */
    async handleWechatRefundCallback(
        rawBody: string,
        signature: string,
        headers?: PaymentCallbackHeaders,
    ): Promise<{ handled: boolean; message?: string }> {
        const provider = this.providers.get(PaymentChannel.WECHAT);

        if (!provider.parseRefundCallback) {
            return {
                handled: false,
                message: 'Refund callbacks are not supported by this channel',
            };
        }

        const parsed = await provider.parseRefundCallback(
            rawBody,
            signature,
            headers,
        );

        const refund = await this.prisma.refund.findUnique({
            where: { refundNo: parsed.outRefundNo },
        });

        if (!refund) {
            this.logger.warn(
                `Refund callback for unknown refundNo ${parsed.outRefundNo}`,
            );

            return { handled: false, message: 'Refund not found' };
        }

        if (parsed.status === 'SUCCESS') {
            await this.markSuccess(refund.id, parsed);
        } else if (parsed.status === 'FAILED') {
            await this.markFailed(
                refund.id,
                parsed.failureReason ?? 'Channel closed the refund',
            );
        } else {
            await this.markProcessing(refund.id, parsed);
        }

        return { handled: true };
    }

    /**
     * 失败重试：用同一个 `refundNo` 重新提交。
     *
     * 渠道都以退款单号做幂等键（微信 `out_refund_no`、支付宝 `out_request_no`），
     * 所以重试不会退第二次钱，最坏情况返回「已退过」。
     */
    async retry(refundId: string): Promise<RefundModel> {
        const refund = await this.prisma.refund.findUnique({
            where: { id: refundId },
        });

        if (!refund) throw new NotFoundException('Refund not found');
        if (refund.status !== FAILED) {
            throw new BadRequestException(
                'Only a failed refund can be retried',
            );
        }

        const [order, payment] = await Promise.all([
            this.prisma.order.findUniqueOrThrow({
                where: { id: refund.orderId },
            }),
            this.prisma.payment.findUnique({
                where: { orderId: refund.orderId },
            }),
        ]);

        if (!payment) {
            throw new BadRequestException('Order has no payment to refund');
        }

        const pending = await this.prisma.refund.update({
            where: { id: refund.id },
            data: { status: PENDING, failureReason: null },
        });

        return this.submit(pending, order, payment);
    }

    /** 人工关闭（被拒、无法原路退回、用户撤回）。 */
    async markClosed(refundId: string, reason?: string): Promise<RefundModel> {
        await this.prisma.refund.updateMany({
            where: {
                id: refundId,
                status: { in: [PENDING, PROCESSING, FAILED] },
            },
            data: {
                status: CLOSED,
                failureReason: reason?.slice(0, 500) ?? null,
            },
        });

        return this.prisma.refund.findUniqueOrThrow({
            where: { id: refundId },
        });
    }

    /** 渠道查询（兜底轮询用）：只推进状态，不改业务。 */
    async syncFromChannel(refundId: string): Promise<RefundModel> {
        const refund = await this.prisma.refund.findUnique({
            where: { id: refundId },
        });

        if (!refund) throw new NotFoundException('Refund not found');
        if (refund.status !== PROCESSING && refund.status !== PENDING) {
            return refund;
        }

        const provider = this.providers.getRefundProvider(refund.channel);

        if (!provider.queryRefund) return refund;

        const order = await this.prisma.order.findUniqueOrThrow({
            where: { id: refund.orderId },
        });
        const result = await provider.queryRefund({
            refundNo: refund.refundNo,
            outTradeNo: order.orderNo,
            orderId: order.id,
        });

        if (result.status === 'SUCCESS') {
            return this.markSuccess(refund.id, result);
        }
        if (result.status === 'FAILED') {
            return this.markFailed(
                refund.id,
                result.failureReason ?? 'Channel rejected the refund',
            );
        }

        return this.markProcessing(refund.id, result);
    }

    /** 用户端：某订单的退款记录（含归属校验，裁掉内部字段）。 */
    async listForOrder(
        orderId: string,
        actorUserId: string,
    ): Promise<UserRefundView[]> {
        const order = await this.requireOrder(orderId);

        await this.assertMembership(order.organizationId, actorUserId);

        const refunds = await this.prisma.refund.findMany({
            where: { orderId },
            orderBy: { createdAt: 'desc' },
        });

        return refunds.map((refund) => toUserRefundView(refund));
    }

    // -- 内部 ------------------------------------------------------------

    /** 用户端入口的归属校验：不是该组织成员就当作订单不存在。 */
    private async assertMembership(
        organizationId: string,
        userId: string,
    ): Promise<void> {
        if (!userId) throw new NotFoundException('Order not found');

        const membership = await this.prisma.membership.findUnique({
            where: { userId_organizationId: { userId, organizationId } },
            select: { id: true },
        });

        if (!membership) throw new NotFoundException('Order not found');
    }

    private async requireOrder(orderId: string): Promise<OrderModel> {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
        });

        if (!order) throw new NotFoundException('Order not found');

        return order;
    }

    /** 一单一退：在途或已成功的退款都拒绝重复发起。 */
    private async assertNothingInFlight(orderId: string): Promise<void> {
        const existing = await this.prisma.refund.findFirst({
            where: {
                orderId,
                status: { in: [PENDING, PROCESSING, SUCCESS] },
            },
            select: { status: true },
        });

        if (!existing) return;

        throw new BadRequestException(
            existing.status === SUCCESS
                ? 'This order has already been refunded'
                : 'A refund for this order is already in progress',
        );
    }

    private manualAmount(
        amount: number | undefined,
        quote: RefundQuote,
    ): number {
        if (!Number.isInteger(amount) || (amount ?? 0) <= 0) {
            throw new BadRequestException(
                'A manual refund requires a positive integer amount in cents',
            );
        }

        if ((amount as number) > quote.maxRefundable) {
            throw new BadRequestException(
                `Refund cannot exceed ${quote.maxRefundable} cents`,
            );
        }

        return amount as number;
    }

    private async submit(
        refund: RefundModel,
        order: OrderModel,
        payment: PaymentModel,
    ): Promise<RefundModel> {
        try {
            const result = await this.providers
                .getRefundProvider(refund.channel)
                .refund({
                    outRefundNo: refund.refundNo,
                    outTradeNo: order.orderNo,
                    // 虚拟支付要用订单 id 找支付尝试（openid + 真实单号）
                    orderId: order.id,
                    transactionId: payment.transactionId ?? undefined,
                    refundFee: refund.amount,
                    totalFee: order.amount,
                    // 虚拟支付退款需要「剩余可退金额」（left_fee）
                    leftFee: order.amount - order.refundedAmount,
                    reason: refund.reason ?? undefined,
                });

            if (result.status === 'SUCCESS') {
                return this.markSuccess(refund.id, result);
            }
            if (result.status === 'PROCESSING') {
                return this.markProcessing(refund.id, result);
            }

            return this.markFailed(
                refund.id,
                result.failureReason ?? 'Channel rejected the refund',
            );
        } catch (error) {
            const reason =
                error instanceof Error ? error.message : String(error);

            this.logger.warn(
                `Refund ${refund.refundNo} failed at the channel: ${reason}`,
            );

            return this.markFailed(refund.id, reason);
        }
    }

    /**
     * 收回订单对应的服务期。
     *
     * - 订单自己建的订阅段（`subscription.orderId === order.id`）：未开始就
     *   作废，已开始就立即到期；
     * - 续费订单（只延长了有效期）：把未使用天数从 `expiresAt` 扣回去；
     * - 找不到订阅（历史数据/人工补录）：只落账，不动权益。
     */
    private async reclaimSubscription(
        tx: Prisma.TransactionClient,
        refund: RefundModel,
        order: OrderModel,
    ): Promise<void> {
        const now = new Date();

        const ownSegment = await tx.subscription.findFirst({
            where: { orderId: order.id },
            select: { id: true, startsAt: true },
        });

        if (ownSegment) {
            const notStarted = ownSegment.startsAt.getTime() > now.getTime();

            await tx.subscription.update({
                where: { id: ownSegment.id },
                data: {
                    status: notStarted
                        ? SubscriptionStatus.CANCELLED
                        : SubscriptionStatus.EXPIRED,
                    expiresAt: notStarted ? ownSegment.startsAt : now,
                },
            });

            return;
        }

        const renewal = await tx.subscription.findFirst({
            where: {
                organizationId: order.organizationId,
                planId: order.planId,
                status: SubscriptionStatus.ACTIVE,
            },
            orderBy: { expiresAt: 'desc' },
            select: { id: true, expiresAt: true },
        });

        if (!renewal) {
            this.logger.warn(
                `No subscription found for refunded order ${order.orderNo}; subscription left untouched`,
            );

            return;
        }

        const remainingDays = Math.max(0, refund.remainingDays ?? 0);
        const shrunk = new Date(
            renewal.expiresAt.getTime() - remainingDays * DAY_MS,
        );
        const expiresAt = shrunk.getTime() > now.getTime() ? shrunk : now;

        await tx.subscription.update({
            where: { id: renewal.id },
            data: {
                expiresAt,
                status:
                    expiresAt.getTime() <= now.getTime()
                        ? SubscriptionStatus.EXPIRED
                        : SubscriptionStatus.ACTIVE,
            },
        });
    }

    private async publishRefunded(
        tx: Prisma.TransactionClient,
        refund: RefundModel,
        order: OrderModel,
    ): Promise<void> {
        const recipients = [
            order.userId,
            ...(await this.notifications.organizationRecipients(
                order.organizationId,
                tx,
                ADMIN_ROLES,
            )),
        ];

        await this.notifications.publish(
            {
                eventKey: `payment-refunded:${refund.id}`,
                type: NotificationType.PAYMENT_REFUNDED,
                accessScope: 'ORGANIZATION',
                title: 'Payment refunded',
                body: `Order ${order.orderNo} was refunded ${(refund.amount / 100).toFixed(2)} CNY. The related service period has been closed.`,
                organizationId: order.organizationId,
                recipients,
                includeActor: true,
                email: true,
                resourceType: 'Order',
                resourceId: order.id,
                meta: {
                    refundNo: refund.refundNo,
                    amount: refund.amount,
                    policyCode: refund.policyCode,
                },
            },
            tx,
        );
    }
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined || value === null) return undefined;

    return value;
}

/** 用户端只看到自己的退款进度，渠道原始报文与审批人属于内部信息。 */
export function toUserRefundView(refund: RefundModel): UserRefundView {
    return {
        id: refund.id,
        refundNo: refund.refundNo,
        status: refund.status,
        type: refund.type,
        amount: refund.amount,
        settledAmount: refund.settledAmount,
        policyCode: refund.policyCode,
        usedDays: refund.usedDays,
        remainingDays: refund.remainingDays,
        reason: refund.reason,
        failureReason: refund.failureReason,
        refundedAt: refund.refundedAt,
        createdAt: refund.createdAt,
    };
}
