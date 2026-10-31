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
} from '../../../generated/prisma/enums';
import type {
    OrderModel,
    PaymentModel,
    RefundModel,
} from '../../../generated/prisma/models';
import { PrismaService } from '../../../infra/database/prisma.service';
import { EffectivePlanService } from '../../../shared/subscription/effective-plan.service';
import {
    entitlementReviewRequired,
    entitlementUsage,
    orderEntitlement,
    reclaimOrderEntitlement,
} from '../../../shared/subscription/subscription-entitlements';
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
import { quoteRefund, type RefundQuote } from './refund-policy';

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
 * 三条不变量（组织行锁、条件更新和有效退款唯一索引共同保证）：
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
     * 政策试算：用户/后台都能调；可在锁内回填可证明的历史权益账本。
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
        const config = await this.refundConfig.config();
        return this.prisma.$transaction(async (tx) => {
            await this.lockOrganization(tx, order.organizationId);
            if (actorUserId)
                await this.assertMembership(
                    order.organizationId,
                    actorUserId,
                    tx,
                );
            return this.quoteInTransaction(
                tx,
                await this.requireOrder(orderId, tx),
                now,
                config,
            );
        });
    }

    /**
     * 创建并发起退款。
     *
     * 渠道调用不放在事务里：网络请求可长可短，长事务会锁住租户行；建单先落
     * `PENDING` 仅等待审批；提交资格和 PROCESSING 先持久化，未知结果等待核对。
     */
    async create(input: CreateRefundInput): Promise<RefundModel> {
        const origin = input.origin ?? 'ADMIN';
        const config = await this.refundConfig.config();
        if (!config.enabled) {
            throw new BadRequestException('Refunds are disabled');
        }

        // 用户自助是灰度能力：后台没打开开关时，用户端一个都不能提交。
        if (origin === 'USER' && !config.userSelfService) {
            throw new ForbiddenException('Self-service refunds are disabled');
        }
        if (origin === 'USER' && !input.actorUserId)
            throw new ForbiddenException('Refund actor required');
        const metadata = await this.requireOrder(input.orderId);
        const prepared = await this.prisma.$transaction(async (tx) => {
            await this.lockOrganization(tx, metadata.organizationId);
            const order = await this.requireOrder(input.orderId, tx);
            if (origin === 'USER')
                await this.assertMembership(
                    order.organizationId,
                    input.actorUserId!,
                    tx,
                );
            const payment = await this.requireRefundablePayment(tx, order);
            await this.assertNothingInFlight(order.id, tx);
            const { quote } = await this.quoteInTransaction(
                tx,
                order,
                new Date(),
                config,
            );
            if (quote.requiresManualReview) throw entitlementReviewRequired();
            const manual = input.type === RefundType.MANUAL;
            const amount = manual
                ? this.manualAmount(input.amount, quote)
                : quote.amount;
            if (!manual && !quote.eligible)
                throw new BadRequestException(
                    quote.reason ?? 'This order is not refundable',
                );
            this.assertBalance(order, payment, amount);
            const autoApprove =
                origin === 'ADMIN' ||
                (config.autoApproveLimit > 0 &&
                    amount <= config.autoApproveLimit);
            const refund = await tx.refund.create({
                data: {
                    refundNo: generateRefundNo(),
                    orderId: order.id,
                    organizationId: order.organizationId,
                    channel: payment.channel,
                    type: manual ? RefundType.MANUAL : quote.type,
                    status: autoApprove ? PROCESSING : PENDING,
                    submittedAt: autoApprove ? new Date() : null,
                    amount,
                    policyCode: manual ? 'MANUAL' : quote.policyCode,
                    usedDays: quote.usedDays,
                    remainingDays: quote.remainingDays,
                    reason: input.reason?.trim() || null,
                    requestedBy: input.requestedBy ?? null,
                },
            });
            return { refund, order, payment };
        });
        return prepared.refund.status === PENDING
            ? prepared.refund
            : this.submit(prepared.refund, prepared.order, prepared.payment);
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
        const prepared = await this.authorizeSubmission(
            refundId,
            PENDING,
            adminUserId,
        );
        return this.submit(prepared.refund, prepared.order, prepared.payment);
    }

    /** 渠道已受理但还没终态（微信常见）。 */
    async markProcessing(
        refundId: string,
        result: PaymentProviderRefundResult,
    ): Promise<RefundModel> {
        await this.prisma.refund.updateMany({
            where: {
                id: refundId,
                status: PROCESSING,
                submittedAt: { not: null },
            },
            data: {
                status: PROCESSING,
                channelRefundId: result.channelRefundId ?? undefined,
                rawResponse: toJson(result.raw),
                failureReason: result.failureReason ?? null,
            },
        });

        return this.prisma.refund.findUniqueOrThrow({
            where: { id: refundId },
        });
    }

    async markFailed(refundId: string, reason: string): Promise<RefundModel> {
        await this.prisma.refund.updateMany({
            where: {
                id: refundId,
                status: PROCESSING,
                submittedAt: { not: null },
            },
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
        if (
            result.refundFee !== undefined &&
            (!Number.isSafeInteger(result.refundFee) ||
                result.refundFee !== refund.amount)
        ) {
            throw new BadRequestException('Refund amount mismatch');
        }

        await this.prisma.$transaction(async (tx) => {
            // 与支付回调、订阅过期扫描共用同一把租户锁，避免订阅栈并发错乱。
            await this.lockOrganization(tx, refund.organizationId);
            const current = await tx.refund.findUniqueOrThrow({
                where: { id: refundId },
            });
            if (current.status === SUCCESS) return;
            if (!current.submittedAt || current.status === PENDING) {
                throw new BadRequestException(
                    'Refund has not been authorized for submission',
                );
            }
            const order = await tx.order.findUniqueOrThrow({
                where: { id: refund.orderId },
            });
            const payment = await this.requireRefundablePayment(tx, order);
            await this.assertNothingInFlight(order.id, tx, refundId);
            this.assertBalance(order, payment, current.amount);
            // Hydrate legacy PAID orders before changing their financial status.
            if (!(await orderEntitlement(tx, order)))
                throw entitlementReviewRequired();

            const updated = await tx.refund.updateMany({
                where: {
                    id: refundId,
                    status: current.status,
                    submittedAt: current.submittedAt,
                },
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

            await reclaimOrderEntitlement(tx, order, new Date());

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

        const order = await this.prisma.order.findUniqueOrThrow({
            where: { id: refund.orderId },
        });
        const payment = await this.prisma.payment.findUnique({
            where: { orderId: refund.orderId },
        });
        if (
            refund.channel !== PaymentChannel.WECHAT ||
            !Number.isSafeInteger(parsed.refundFee) ||
            parsed.refundFee !== refund.amount ||
            !Number.isSafeInteger(parsed.totalFee) ||
            parsed.totalFee !== order.amount ||
            (parsed.currency !== undefined && parsed.currency !== 'CNY') ||
            (parsed.outTradeNo !== undefined &&
                parsed.outTradeNo !== (payment?.outTradeNo ?? order.orderNo)) ||
            (parsed.transactionId !== undefined &&
                parsed.transactionId !== payment?.transactionId)
        ) {
            this.logger.error(
                `Refund callback amount or payment mismatch for ${refund.refundNo}`,
            );
            return {
                handled: false,
                message: 'Refund amount or payment mismatch',
            };
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
        const prepared = await this.authorizeSubmission(refundId, FAILED);
        return this.submit(prepared.refund, prepared.order, prepared.payment);
    }

    /** 拒绝/撤回尚未提交渠道的待审批申请。 */
    async markClosed(refundId: string, reason?: string): Promise<RefundModel> {
        const metadata = await this.prisma.refund.findUnique({
            where: { id: refundId },
        });
        if (!metadata) throw new NotFoundException('Refund not found');
        return this.prisma.$transaction(async (tx) => {
            await this.lockOrganization(tx, metadata.organizationId);
            const current = await tx.refund.findUniqueOrThrow({
                where: { id: refundId },
            });
            if (current.status === CLOSED) return current;
            if (current.status !== PENDING || current.submittedAt) {
                throw new BadRequestException(
                    'Only an unsubmitted pending refund can be closed',
                );
            }
            return tx.refund.update({
                where: { id: refundId, status: PENDING, submittedAt: null },
                data: {
                    status: CLOSED,
                    failureReason: reason?.slice(0, 500) ?? null,
                },
            });
        });
    }

    /** 渠道核对：已提交请求查无记录时原号重放；成功时统一落账。 */
    async syncFromChannel(refundId: string): Promise<RefundModel> {
        const refund = await this.prisma.refund.findUnique({
            where: { id: refundId },
        });

        if (!refund) throw new NotFoundException('Refund not found');
        if (refund.status !== PROCESSING || !refund.submittedAt) {
            return refund;
        }

        const provider = this.providers.getRefundProvider(refund.channel);

        if (!provider.queryRefund) return refund;

        const order = await this.prisma.order.findUniqueOrThrow({
            where: { id: refund.orderId },
        });
        const payment = await this.prisma.payment.findUnique({
            where: { orderId: order.id },
        });
        let result: PaymentProviderRefundResult;
        try {
            result = await provider.queryRefund({
                refundNo: refund.refundNo,
                outTradeNo: payment?.outTradeNo ?? order.orderNo,
                orderId: order.id,
            });
        } catch (error) {
            // Advance the scan cursor even on a channel outage so one batch of
            // failing records cannot starve every later refund indefinitely.
            await this.markProcessing(refund.id, {
                status: 'PROCESSING',
                failureReason: `Channel query unavailable: ${this.errorText(error)}`,
            });
            throw error;
        }
        if (result.notFound) {
            if (!payment)
                throw new BadRequestException('Order has no payment to refund');
            const current = await this.prisma.refund.findUniqueOrThrow({
                where: { id: refundId },
            });
            if (current.status !== PROCESSING) return current;
            // The original merchant refund number/amount are immutable. This
            // also recovers a crash after durable authorization, before I/O.
            return this.submit(current, order, payment);
        }

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
        tx: Prisma.TransactionClient = this.prisma,
    ): Promise<void> {
        if (!userId) throw new NotFoundException('Order not found');

        const membership = await tx.membership.findUnique({
            where: { userId_organizationId: { userId, organizationId } },
            select: { id: true },
        });

        if (!membership) throw new NotFoundException('Order not found');
    }

    private async requireOrder(
        orderId: string,
        tx: Prisma.TransactionClient = this.prisma,
    ): Promise<OrderModel> {
        const order = await tx.order.findUnique({
            where: { id: orderId },
        });

        if (!order) throw new NotFoundException('Order not found');

        return order;
    }

    /** 一单一退：在途或已成功的退款都拒绝重复发起。 */
    private async assertNothingInFlight(
        orderId: string,
        tx: Prisma.TransactionClient,
        exceptId?: string,
    ): Promise<void> {
        const existing = await tx.refund.findFirst({
            where: {
                orderId,
                ...(exceptId ? { id: { not: exceptId } } : {}),
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
        let result: PaymentProviderRefundResult;
        try {
            result = await this.providers
                .getRefundProvider(refund.channel)
                .refund({
                    outRefundNo: refund.refundNo,
                    outTradeNo: payment.outTradeNo ?? order.orderNo,
                    // 虚拟支付要用订单 id 找支付尝试（openid + 真实单号）
                    orderId: order.id,
                    transactionId: payment.transactionId ?? undefined,
                    refundFee: refund.amount,
                    totalFee: order.amount,
                    // 虚拟支付退款需要「剩余可退金额」（left_fee）
                    leftFee: order.amount - order.refundedAmount,
                    reason: refund.reason ?? undefined,
                });
        } catch (error) {
            const reason = this.errorText(error);
            this.logger.warn(
                `Refund ${refund.refundNo} has an unknown channel result: ${reason}`,
            );
            return this.markProcessing(refund.id, {
                status: 'PROCESSING',
                failureReason: reason,
            });
        }
        // Persistence/notification failures must propagate and roll back. They
        // are not evidence that the channel rejected the refund.
        if (result.status === 'SUCCESS')
            return this.markSuccess(refund.id, result);
        if (result.status === 'PROCESSING')
            return this.markProcessing(refund.id, result);
        return this.markFailed(
            refund.id,
            result.failureReason ?? 'Channel rejected the refund',
        );
    }

    private lockOrganization(
        tx: Prisma.TransactionClient,
        organizationId: string,
    ) {
        return tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId} FOR UPDATE`;
    }

    private async quoteInTransaction(
        tx: Prisma.TransactionClient,
        order: OrderModel,
        now: Date,
        config: RefundRuntimeConfig,
    ): Promise<RefundQuoteResult> {
        const entry = await orderEntitlement(tx, order);
        const usage = entry
            ? entitlementUsage(entry, entry.subscription, now)
            : null;
        const other = entry
            ? await tx.subscriptionEntitlement.findMany({
                  where: {
                      subscriptionId: entry.subscriptionId,
                      orderId: { not: order.id },
                  },
              })
            : [];
        const shared = other.some((row) => +row.endsAt > +row.startsAt);
        const quote = quoteRefund(
            {
                amount: order.amount,
                durationDays: order.durationDays,
                paidAt: order.paidAt,
                refundedAmount: order.refundedAmount,
                serviceStartsAt: usage
                    ? usage.notStarted
                        ? new Date(+now + 1)
                        : new Date(+now - usage.consumedMs)
                    : order.serviceStartsAt,
                serviceEndsAt: usage
                    ? new Date(+now + usage.remainingMs)
                    : order.serviceEndsAt,
                hasOwnSubscription: Boolean(entry && !shared),
            },
            now,
            config,
        );
        if (!entry) {
            quote.eligible = false;
            quote.requiresManualReview = true;
            quote.reason =
                'Order service history requires manual reconciliation before refunding.';
        }
        return { order, quote, config };
    }

    private async requireRefundablePayment(
        tx: Prisma.TransactionClient,
        order: OrderModel,
    ) {
        if (order.status !== OrderStatus.PAID)
            throw new BadRequestException(
                `Cannot refund an order with status ${order.status}`,
            );
        const payment = await tx.payment.findUnique({
            where: { orderId: order.id },
        });
        if (!payment || payment.status !== PaymentStatus.SUCCESS)
            throw new BadRequestException(
                'Order has no successful payment to refund',
            );
        return payment;
    }

    private assertBalance(
        order: OrderModel,
        payment: PaymentModel,
        amount: number,
    ) {
        if (
            !Number.isSafeInteger(amount) ||
            amount <= 0 ||
            amount > order.amount - order.refundedAmount ||
            amount > payment.amount - payment.refundedAmount
        ) {
            throw new BadRequestException(
                'Refund exceeds the remaining paid amount',
            );
        }
    }

    private async authorizeSubmission(
        refundId: string,
        expected: typeof PENDING | typeof FAILED,
        adminUserId?: string,
    ) {
        const metadata = await this.prisma.refund.findUnique({
            where: { id: refundId },
        });
        if (!metadata) throw new NotFoundException('Refund not found');
        return this.prisma.$transaction(async (tx) => {
            await this.lockOrganization(tx, metadata.organizationId);
            const current = await tx.refund.findUniqueOrThrow({
                where: { id: refundId },
            });
            if (
                current.status !== expected ||
                (expected === PENDING && current.submittedAt)
            ) {
                throw new BadRequestException(
                    expected === PENDING
                        ? 'Only a pending refund can be approved'
                        : 'Only a failed refund can be retried',
                );
            }
            const order = await this.requireOrder(current.orderId, tx);
            const payment = await this.requireRefundablePayment(tx, order);
            await this.assertNothingInFlight(order.id, tx, refundId);
            this.assertBalance(order, payment, current.amount);
            if (!(await orderEntitlement(tx, order)))
                throw entitlementReviewRequired();
            const claimed = await tx.refund.updateMany({
                where: { id: refundId, status: expected },
                data: {
                    status: PROCESSING,
                    submittedAt: current.submittedAt ?? new Date(),
                    failureReason: null,
                    ...(expected === PENDING
                        ? { approvedBy: adminUserId ?? null }
                        : {}),
                },
            });
            if (!claimed.count)
                throw new BadRequestException(
                    'Refund submission already claimed',
                );
            return {
                refund: await tx.refund.findUniqueOrThrow({
                    where: { id: refundId },
                }),
                order,
                payment,
            };
        });
    }

    private errorText(error: unknown) {
        return (error instanceof Error ? error.message : String(error)).slice(
            0,
            500,
        );
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
