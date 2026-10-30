import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../../../infra/database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import {
    OrderStatus,
    PaymentAttemptStatus,
    PaymentChannel,
    PaymentStatus,
} from '../../../generated/prisma/enums';
import { NotificationsService } from '../../notifications/notifications.service';
import type {
    OrderModel,
    PaymentAttemptModel,
} from '../../../generated/prisma/models';
import { CreatePaymentDto } from './dto';
import { PaymentProviderFactory } from './payment-provider.factory';
import type {
    PaymentCallbackHeaders,
    PaymentProviderCallbackResult,
    PaymentProviderPayParams,
} from './payment-provider.interface';
import { settlePaidOrder } from './payment-settlement';
import { resolvePaidAmountFen } from './callback-amount';
import { EffectivePlanService } from '../../../shared/subscription/effective-plan.service';
import { ADMIN_ROLES } from '../../notifications/notification-event';

type OrderForPayment = OrderModel;

/** WeChat Pay V3 callback acknowledgement body (`code` + `message`). */
export interface PaymentCallbackResponse {
    code: 'SUCCESS' | 'FAIL';
    message?: string;
}

@Injectable()
export class PaymentService {
    private readonly logger = new Logger(PaymentService.name);
    constructor(
        private readonly prisma: PrismaService,
        private readonly paymentProviderFactory: PaymentProviderFactory,
        private readonly notifications: NotificationsService,
        private readonly plans: EffectivePlanService,
    ) {}

    async createPayment(
        orderId: string,
        userId: string,
        dto: CreatePaymentDto,
    ): Promise<PaymentProviderPayParams & { outTradeNo: string }> {
        const order = await this.ensureOrderPayable(orderId, userId);
        const channel = dto.channel ?? PaymentChannel.WECHAT;
        if (channel === PaymentChannel.WECHAT_VIRTUAL) {
            throw new BadRequestException(
                'The WECHAT_VIRTUAL channel is served by the mini-program virtual payment flow',
            );
        }
        const openid = dto.openid?.trim();
        if (channel === PaymentChannel.WECHAT && !openid) {
            throw new BadRequestException(
                'openid is required for the WECHAT (JSAPI) channel',
            );
        }
        await this.assertChannelSwitchable(order.id, channel);
        const provider = this.paymentProviderFactory.get(channel);
        const outTradeNo = `P${randomBytes(15).toString('hex')}`;
        const attempt = await this.prisma.$transaction(async (tx) => {
            const current = await this.lockOrder(tx, order);
            if (
                current.status !== OrderStatus.PENDING ||
                current.expiresAt <= new Date()
            ) {
                throw new BadRequestException('Order is no longer payable');
            }
            const existing = await tx.payment.findUnique({
                where: { orderId },
            });
            if (
                existing?.status === PaymentStatus.SUCCESS ||
                existing?.status === PaymentStatus.REFUNDED
            ) {
                throw new BadRequestException('Order is already paid');
            }
            if (
                existing &&
                !existing.outTradeNo &&
                existing.channel !== PaymentChannel.WECHAT_VIRTUAL
            ) {
                await tx.paymentAttempt.upsert({
                    where: { outTradeNo: order.orderNo },
                    update: {},
                    create: {
                        orderId,
                        channel: existing.channel,
                        outTradeNo: order.orderNo,
                        openid: '',
                        amount: existing.amount,
                    },
                });
            }
            const created = await tx.paymentAttempt.create({
                data: {
                    orderId,
                    channel,
                    outTradeNo,
                    openid: openid ?? '',
                    amount: current.amount,
                },
            });
            await tx.payment.upsert({
                where: { orderId },
                create: {
                    orderId,
                    channel,
                    outTradeNo,
                    amount: current.amount,
                    status: PaymentStatus.PENDING,
                },
                update: {
                    channel,
                    outTradeNo,
                    prepayId: null,
                    status: PaymentStatus.PENDING,
                },
            });
            return created;
        });
        try {
            const params = await provider.createPayment({
                outTradeNo,
                totalFee: attempt.amount,
                payerId: openid,
                payMethod: dto.payMethod,
                body: `Beaconix plan order ${order.orderNo}`,
                expiresAt: order.expiresAt,
            });
            const payable = await this.prisma.$transaction(async (tx) => {
                const current = await this.lockOrder(tx, order);
                await tx.paymentAttempt.updateMany({
                    where: { id: attempt.id },
                    data: { prepayId: this.extractPrepayId(params) },
                });
                const completed = await tx.paymentAttempt.findUnique({
                    where: { id: attempt.id },
                });
                if (
                    current.status === OrderStatus.PAID &&
                    completed?.status === PaymentAttemptStatus.PAID
                )
                    return true;
                if (
                    current.status !== OrderStatus.PENDING ||
                    current.expiresAt <= new Date()
                ) {
                    await tx.paymentAttempt.updateMany({
                        where: {
                            id: attempt.id,
                            status: { not: PaymentAttemptStatus.PAID },
                        },
                        data: { closePending: true },
                    });
                    return false;
                }
                await tx.payment.updateMany({
                    where: {
                        orderId,
                        outTradeNo,
                        status: PaymentStatus.PENDING,
                    },
                    data: { prepayId: this.extractPrepayId(params) },
                });
                return true;
            });
            if (!payable) {
                await this.syncAttempt(attempt, true);
                throw new BadRequestException('Order is no longer payable');
            }
            return { ...params, outTradeNo };
        } catch (error) {
            await this.prisma.paymentAttempt.updateMany({
                where: { id: attempt.id, status: PaymentAttemptStatus.PENDING },
                data: {
                    status: PaymentAttemptStatus.FAILED,
                    lastError: this.errorText(error),
                },
            });
            await this.prisma.payment.updateMany({
                where: { orderId, outTradeNo, status: PaymentStatus.PENDING },
                data: { status: PaymentStatus.FAILED },
            });
            throw error;
        }
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

    /**
     * 支付宝异步通知：签名在 provider 里用 `alipay-sdk` 校验（参数放在
     * form-urlencoded 报文里，不走 `signature` 头），之后与微信完全同一条路径。
     */
    async handleAlipayCallback(
        rawBody: string,
    ): Promise<PaymentCallbackResponse> {
        return this.handleCallback(PaymentChannel.ALIPAY, rawBody, '');
    }

    /** Channel-agnostic callback processing through the provider factory. */
    async handleCallback(
        channel: PaymentChannel,
        rawBody: string,
        signature: string,
        headers?: PaymentCallbackHeaders,
    ): Promise<PaymentCallbackResponse> {
        const callback = await this.paymentProviderFactory
            .get(channel)
            .verifyCallback(rawBody, signature, headers);
        return (await this.applyChannelResult(channel, callback)).response;
    }

    /** Both authenticated channel queries and signature-verified callbacks enter here. */
    private async applyChannelResult(
        channel: PaymentChannel,
        callback: PaymentProviderCallbackResult,
        leaseToken?: string,
    ): Promise<{ response: PaymentCallbackResponse; settled: boolean }> {
        const attempt = await this.prisma.paymentAttempt.findUnique({
            where: { outTradeNo: callback.out_trade_no },
            include: { order: true },
        });
        const legacy = !attempt
            ? await this.prisma.payment.findFirst({
                  where: { channel, order: { orderNo: callback.out_trade_no } },
                  include: { order: true },
              })
            : null;
        if ((!attempt && !legacy) || (attempt && attempt.channel !== channel)) {
            return {
                response: { code: 'FAIL', message: 'Payment not found' },
                settled: false,
            };
        }
        const order = (attempt ?? legacy)!.order;
        return this.prisma.$transaction(async (tx) => {
            const currentOrder = await this.lockOrder(tx, order);
            // Pin the claimed attempt for this short transaction. A replacement
            // worker cannot claim it between lease admission and settlement.
            if (attempt)
                await tx.$queryRaw`SELECT id FROM payment_attempts WHERE id = ${attempt.id} FOR UPDATE`;
            const currentAttempt = attempt
                ? await tx.paymentAttempt.findUniqueOrThrow({
                      where: { id: attempt.id },
                  })
                : null;
            if (
                leaseToken &&
                (currentAttempt?.reconcileLeaseToken !== leaseToken ||
                    !currentAttempt.reconcileLeaseUntil ||
                    currentAttempt.reconcileLeaseUntil <= new Date())
            ) {
                return {
                    response: {
                        code: 'FAIL',
                        message: 'Reconciliation lease expired',
                    },
                    settled: false,
                };
            }
            const payment = await tx.payment.findUnique({
                where: { orderId: order.id },
            });
            const fail = async (reason: string, terminal = true) => {
                if (terminal)
                    this.logger.error(
                        `Payment rejected: ${reason} (${callback.out_trade_no})`,
                    );
                if (terminal) {
                    if (currentAttempt && callback.trade_state !== 'CLOSED')
                        await tx.paymentAttempt.updateMany({
                            where: {
                                id: currentAttempt.id,
                                status: { not: PaymentAttemptStatus.PAID },
                            },
                            data: {
                                status: PaymentAttemptStatus.FAILED,
                                lastError: reason,
                                rawNotify: callback as Prisma.InputJsonValue,
                            },
                        });
                    if (payment)
                        await tx.payment.updateMany({
                            where: {
                                id: payment.id,
                                status: {
                                    notIn: [
                                        PaymentStatus.SUCCESS,
                                        PaymentStatus.REFUNDED,
                                    ],
                                },
                                ...(attempt
                                    ? { outTradeNo: attempt.outTradeNo }
                                    : {}),
                            },
                            data: {
                                status: PaymentStatus.FAILED,
                                rawCallback: callback as Prisma.InputJsonValue,
                            },
                        });
                }
                return {
                    response: { code: 'FAIL' as const, message: reason },
                    settled: false,
                };
            };
            if (callback.trade_state !== 'SUCCESS') {
                if (callback.trade_state === 'CLOSED' && currentAttempt) {
                    await tx.paymentAttempt.updateMany({
                        where: {
                            id: currentAttempt.id,
                            status: { not: PaymentAttemptStatus.PAID },
                        },
                        data: {
                            status: PaymentAttemptStatus.CLOSED,
                            closePending: false,
                            rawNotify: callback as Prisma.InputJsonValue,
                        },
                    });
                }
                return fail(
                    'trade_state is not SUCCESS',
                    callback.trade_state === 'PAYERROR' ||
                        callback.trade_state === 'CLOSED',
                );
            }
            const expected = currentAttempt?.amount ?? legacy!.amount;
            const paid = resolvePaidAmountFen(channel, callback);
            if (
                paid === null ||
                paid !== expected ||
                expected !== currentOrder.amount
            ) {
                return fail(
                    `Amount mismatch (paid ${paid ?? 'unknown'}, expected ${expected})`,
                );
            }
            const transactionId = callback.transaction_id?.trim() || null;
            if (
                currentAttempt?.status === PaymentAttemptStatus.PAID ||
                (!attempt && payment?.status === PaymentStatus.SUCCESS)
            ) {
                return {
                    response: { code: 'SUCCESS', message: '成功' },
                    settled: false,
                };
            }
            if (
                currentOrder.status !== OrderStatus.PENDING &&
                currentOrder.status !== OrderStatus.PAID
            ) {
                const rejected = await fail(`Order is ${currentOrder.status}`);
                if (currentAttempt) {
                    await tx.paymentAttempt.updateMany({
                        where: { id: currentAttempt.id },
                        data: {
                            status: PaymentAttemptStatus.PAID,
                            wxOrderId: transactionId,
                            paidAt: new Date(),
                            closePending: false,
                            lastError: `Order is ${currentOrder.status}; manual refund required`,
                            rawNotify: callback as Prisma.InputJsonValue,
                        },
                    });
                    await this.notifyDuplicate(
                        tx,
                        order,
                        callback.out_trade_no,
                    );
                }
                return rejected;
            }
            if (
                payment?.status === PaymentStatus.SUCCESS ||
                currentOrder.status === OrderStatus.PAID
            ) {
                if (currentAttempt)
                    await tx.paymentAttempt.updateMany({
                        where: { id: currentAttempt.id },
                        data: {
                            status: PaymentAttemptStatus.PAID,
                            wxOrderId: transactionId,
                            paidAt: new Date(),
                            closePending: false,
                            rawNotify: callback as Prisma.InputJsonValue,
                            lastError:
                                'Duplicate payment; manual refund required',
                        },
                    });
                this.logger.error(
                    `Duplicate payment for order ${order.id}, trade ${callback.out_trade_no}; manual refund required`,
                );
                await this.notifyDuplicate(tx, order, callback.out_trade_no);
                return {
                    response: {
                        code: 'SUCCESS',
                        message: 'Already settled; duplicate recorded',
                    },
                    settled: false,
                };
            }
            let paymentId: string;
            if (!attempt && payment) {
                const updated = await tx.payment.updateMany({
                    where: {
                        id: payment.id,
                        status: { not: PaymentStatus.SUCCESS },
                    },
                    data: {
                        status: PaymentStatus.SUCCESS,
                        transactionId,
                        outTradeNo: callback.out_trade_no,
                        paidAt: new Date(),
                        rawCallback: callback as Prisma.InputJsonValue,
                    },
                });
                if (!updated.count)
                    return {
                        response: { code: 'SUCCESS', message: '成功' },
                        settled: false,
                    };
                paymentId = payment.id;
            } else {
                const saved = await tx.payment.upsert({
                    where: { orderId: order.id },
                    create: {
                        orderId: order.id,
                        channel,
                        amount: expected,
                        status: PaymentStatus.SUCCESS,
                        transactionId,
                        outTradeNo: callback.out_trade_no,
                        paidAt: new Date(),
                        rawCallback: callback as Prisma.InputJsonValue,
                    },
                    update: {
                        channel,
                        amount: expected,
                        status: PaymentStatus.SUCCESS,
                        transactionId,
                        outTradeNo: callback.out_trade_no,
                        paidAt: new Date(),
                        rawCallback: callback as Prisma.InputJsonValue,
                    },
                });
                paymentId = saved.id;
            }
            if (currentAttempt)
                await tx.paymentAttempt.updateMany({
                    where: { id: currentAttempt.id },
                    data: {
                        status: PaymentAttemptStatus.PAID,
                        wxOrderId: transactionId,
                        paidAt: new Date(),
                        closePending: false,
                        lastError: null,
                        rawNotify: callback as Prisma.InputJsonValue,
                    },
                });
            await settlePaidOrder(tx, {
                order: currentOrder,
                paymentId,
                notifications: this.notifications,
            });
            await this.plans.getEffectivePlanInTransaction(
                order.organizationId,
                tx,
            );
            // Stop outstanding checkouts after the first successful settlement.
            await tx.paymentAttempt.updateMany({
                where: {
                    orderId: order.id,
                    channel: {
                        in: [PaymentChannel.WECHAT, PaymentChannel.ALIPAY],
                    },
                    status: {
                        in: [
                            PaymentAttemptStatus.PENDING,
                            PaymentAttemptStatus.FAILED,
                        ],
                    },
                },
                data: { closePending: true },
            });
            return {
                response: { code: 'SUCCESS', message: '成功' },
                settled: true,
            };
        });
    }

    private async lockOrder(
        tx: Prisma.TransactionClient,
        order: Pick<OrderModel, 'id' | 'organizationId'>,
    ): Promise<OrderModel> {
        await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${order.organizationId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
        return tx.order.findUniqueOrThrow({ where: { id: order.id } });
    }

    /** Channel I/O stays outside the database transaction and uses a per-attempt lease. */
    private async syncAttempt(
        attempt: PaymentAttemptModel,
        close = false,
    ): Promise<boolean> {
        const token = randomUUID();
        const claimed = await this.prisma.paymentAttempt.updateMany({
            where: {
                id: attempt.id,
                OR: [
                    { reconcileLeaseUntil: null },
                    { reconcileLeaseUntil: { lte: new Date() } },
                ],
            },
            data: {
                reconcileLeaseToken: token,
                reconcileLeaseUntil: new Date(Date.now() + 120_000),
            },
        });
        if (!claimed.count) return false;
        let errorText: string | null = null;
        try {
            const provider = this.paymentProviderFactory.get(attempt.channel);
            if (!provider.queryPayment)
                throw new Error('Channel does not support payment queries');
            const remote = await provider.queryPayment(attempt.outTradeNo);
            if (remote.out_trade_no !== attempt.outTradeNo)
                throw new Error(
                    'Channel query returned a different merchant number',
                );
            const outcome = await this.applyChannelResult(
                attempt.channel,
                remote,
                token,
            );
            if (remote.trade_state === 'SUCCESS') return outcome.settled;
            const fresh = await this.prisma.paymentAttempt.findUniqueOrThrow({
                where: { id: attempt.id },
                include: { order: true },
            });
            if (
                fresh.reconcileLeaseToken !== token ||
                !fresh.reconcileLeaseUntil ||
                fresh.reconcileLeaseUntil <= new Date()
            )
                return false;
            if (
                (close ||
                    fresh.closePending ||
                    fresh.order.status !== OrderStatus.PENDING) &&
                fresh.status !== PaymentAttemptStatus.PAID &&
                remote.trade_state !== 'CLOSED'
            ) {
                if (!provider.closePayment)
                    throw new Error(
                        'Channel does not support closing payments',
                    );
                try {
                    await provider.closePayment(attempt.outTradeNo);
                } catch (error) {
                    // A user can finish paying between the pre-close query and close.
                    const latest = await provider.queryPayment(
                        attempt.outTradeNo,
                    );
                    if (
                        latest.out_trade_no === attempt.outTradeNo &&
                        latest.trade_state === 'SUCCESS'
                    ) {
                        return (
                            await this.applyChannelResult(
                                attempt.channel,
                                latest,
                                token,
                            )
                        ).settled;
                    }
                    throw error;
                }
                await this.prisma.paymentAttempt.updateMany({
                    where: {
                        id: attempt.id,
                        reconcileLeaseToken: token,
                        reconcileLeaseUntil: { gt: new Date() },
                        status: { not: PaymentAttemptStatus.PAID },
                    },
                    data: {
                        status: PaymentAttemptStatus.CLOSED,
                        closePending: false,
                    },
                });
            }
            return false;
        } catch (error) {
            errorText = this.errorText(error);
            this.logger.warn(
                `Payment reconciliation failed for ${attempt.outTradeNo}: ${errorText}`,
            );
            return false;
        } finally {
            await this.prisma.paymentAttempt.updateMany({
                where: {
                    id: attempt.id,
                    reconcileLeaseToken: token,
                    reconcileLeaseUntil: { gt: new Date() },
                },
                data: {
                    reconcileLeaseToken: null,
                    reconcileLeaseUntil: null,
                    lastCheckedAt: new Date(),
                    ...(errorText ? { lastError: errorText } : {}),
                },
            });
        }
    }

    async reconcilePendingAttempts(): Promise<{
        checked: number;
        settled: number;
    }> {
        const attempts = await this.prisma.paymentAttempt.findMany({
            where: {
                channel: { in: [PaymentChannel.WECHAT, PaymentChannel.ALIPAY] },
                AND: [
                    {
                        OR: [
                            {
                                status: {
                                    in: [
                                        PaymentAttemptStatus.PENDING,
                                        PaymentAttemptStatus.FAILED,
                                    ],
                                },
                            },
                            { closePending: true },
                        ],
                    },
                    {
                        OR: [
                            { reconcileLeaseUntil: null },
                            { reconcileLeaseUntil: { lte: new Date() } },
                        ],
                    },
                ],
            },
            orderBy: [
                { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
                { createdAt: 'asc' },
                { id: 'asc' },
            ],
            take: 100,
        });
        let settled = 0;
        for (const attempt of attempts)
            if (await this.syncAttempt(attempt)) settled += 1;
        return { checked: attempts.length, settled };
    }

    /** Check for lost successful callbacks before cancelling; failed closes stay retryable. */
    async cancelOrder(orderId: string, expiredOnly = false): Promise<boolean> {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
        });
        if (!order) throw new NotFoundException('Order not found');
        if (
            order.status !== OrderStatus.PENDING ||
            (expiredOnly && order.expiresAt > new Date())
        )
            return false;
        const attempts = await this.prisma.paymentAttempt.findMany({
            where: {
                orderId,
                channel: { in: [PaymentChannel.WECHAT, PaymentChannel.ALIPAY] },
                status: {
                    in: [
                        PaymentAttemptStatus.PENDING,
                        PaymentAttemptStatus.FAILED,
                    ],
                },
            },
        });
        for (const attempt of attempts) await this.syncAttempt(attempt, true);
        return this.prisma.$transaction(async (tx) => {
            const current = await this.lockOrder(tx, order);
            if (
                current.status !== OrderStatus.PENDING ||
                (expiredOnly && current.expiresAt > new Date())
            )
                return false;
            const changed = await tx.order.updateMany({
                where: { id: orderId, status: OrderStatus.PENDING },
                data: {
                    status: OrderStatus.CANCELLED,
                    cancelledAt: new Date(),
                },
            });
            if (changed.count)
                await tx.paymentAttempt.updateMany({
                    where: {
                        orderId,
                        channel: {
                            in: [PaymentChannel.WECHAT, PaymentChannel.ALIPAY],
                        },
                        status: {
                            in: [
                                PaymentAttemptStatus.PENDING,
                                PaymentAttemptStatus.FAILED,
                            ],
                        },
                    },
                    data: { closePending: true },
                });
            return changed.count > 0;
        });
    }

    private errorText(error: unknown): string {
        return (error instanceof Error ? error.message : String(error)).slice(
            0,
            500,
        );
    }

    private async notifyDuplicate(
        tx: Prisma.TransactionClient,
        order: OrderModel,
        outTradeNo: string,
    ): Promise<void> {
        await this.notifications.publish(
            {
                eventKey: `payment-duplicate:${order.id}:${outTradeNo}`,
                type: 'PAYMENT_SUCCEEDED',
                accessScope: 'ORGANIZATION',
                title: 'Payment requires a manual refund',
                body: `Order ${order.orderNo}, payment ${outTradeNo} could not be applied. Check this payment and arrange a manual refund.`,
                organizationId: order.organizationId,
                recipients: [
                    order.userId,
                    ...(await this.notifications.organizationRecipients(
                        order.organizationId,
                        tx,
                        ADMIN_ROLES,
                    )),
                ],
                includeActor: true,
                email: true,
                resourceType: 'Order',
                resourceId: order.id,
            },
            tx,
        );
    }

    private extractPrepayId(params: PaymentProviderPayParams): string {
        // 支付宝没有 prepay_id：收银台 URL / 扫码链接存进同一列，便于排查对账。
        const value =
            params['package'] ??
            params['prepayId'] ??
            params['payUrl'] ??
            params['qrCode'] ??
            '';
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
