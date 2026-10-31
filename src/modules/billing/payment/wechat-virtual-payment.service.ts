import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Prisma } from '../../../generated/prisma/client';
import {
    IdentityProvider,
    OrderStatus,
    PaymentAttemptStatus,
    PaymentChannel,
    PaymentStatus,
    RefundStatus,
    RefundType,
} from '../../../generated/prisma/enums';
import type {
    OrderModel,
    PaymentAttemptModel,
} from '../../../generated/prisma/models';
import { PrismaService } from '../../../infra/database/prisma.service';
import {
    buildXpayFailReply,
    buildXpayJsonFailReply,
    buildXpayJsonSuccessReply,
    buildXpaySuccessReply,
    isVirtualPayPaid,
    parseDeliverNotify,
    parseRefundNotify,
    parseXpayJson,
    parseXpayXml,
    readXpayEvent,
    VIRTUAL_PAY_EVENTS,
    VIRTUAL_PAY_ORDER_STATUS,
    VIRTUAL_PAY_REFUND_REASONS,
    VIRTUAL_PAY_REFUND_REQ_FROM,
    WechatVirtualPayClient,
    WechatRuntimeConfigService,
} from '../../../infra/wechat';
import type { VirtualPayOrder } from '../../../infra/wechat';
import { MiniprogramClient } from '../../../infra/wechat/miniprogram';
import {
    checkMsgSignature,
    checkSignature,
    decryptMessage,
} from '../../../infra/wechat/clients';
import { NotificationsService } from '../../notifications/notifications.service';
import { ADMIN_ROLES } from '../../notifications/notification-event';
import type { CreatePaymentDto } from './dto';
import type {
    PaymentProviderRefundInput,
    PaymentProviderRefundResult,
    RefundProvider,
} from './payment-provider.interface';
import { PaymentService } from './payment.service';
import { RefundService } from '../refund/refund.service';
import { generateRefundNo } from '../refund/refund-number.util';
import { settlePaidOrder } from './payment-settlement';
import { EffectivePlanService } from '../../../shared/subscription/effective-plan.service';

/** 兜底查单只回看最近一天：更早的单应该已经在后台人工对账过。 */
const RECONCILE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** 单次兜底扫描的最大条数，避免一次任务把微信接口打满。 */
const RECONCILE_BATCH_SIZE = 20;

type AttemptWithOrder = PaymentAttemptModel & { order: OrderModel };

export interface VirtualPayCreateResult {
    channel: typeof PaymentChannel.WECHAT_VIRTUAL;
    /** 商家业务单号，前端不需要它，但排查问题时必须能看到。 */
    outTradeNo: string;
    mode: string;
    signData: string;
    paySig: string;
    signature: string;
}

export interface VirtualPayNotifyResult {
    /** 直接回给微信的应答体（`ErrCode = 0` 表示不用重试）。 */
    reply: string;
    /** 应答的 Content-Type，跟随推送格式（默认 JSON）。 */
    contentType: 'application/json' | 'text/xml';
    handled: boolean;
}

/**
 * 推送数据格式。
 *
 * 本项目统一用 JSON（MP 后台【消息推送 → 数据格式】选 JSON）；`xml` 只作为
 * 「后台还没切换」时的兜底解析，避免推送被静默丢弃。要彻底移除 XML 支持时，
 * 删掉 `parsePushPayload` / `contentTypeOf` / `successResult` / `failResult`
 * 里的 xml 分支即可。
 */
type PushFormat = 'json' | 'xml';

function detectPushFormat(rawBody: string): PushFormat {
    return rawBody.trimStart().startsWith('<') ? 'xml' : 'json';
}

function parsePushPayload(
    rawBody: string,
    format: PushFormat,
): Record<string, unknown> {
    return format === 'xml' ? parseXpayXml(rawBody) : parseXpayJson(rawBody);
}

function contentTypeOf(format: PushFormat): 'application/json' | 'text/xml' {
    return format === 'json' ? 'application/json' : 'text/xml';
}

/** 成功应答：JSON 走 `{"ErrCode":0,"ErrMsg":"success"}`，XML 走 `<xml>…`。 */
function successResult(
    format: PushFormat,
    handled: boolean,
): VirtualPayNotifyResult {
    return {
        reply:
            format === 'json'
                ? buildXpayJsonSuccessReply()
                : buildXpaySuccessReply(),
        contentType: contentTypeOf(format),
        handled,
    };
}

/** 失败应答：非 0 让平台重试。 */
function failResult(
    format: PushFormat,
    reason: string,
): VirtualPayNotifyResult {
    return {
        reply:
            format === 'json'
                ? buildXpayJsonFailReply(reason)
                : buildXpayFailReply(reason),
        contentType: contentTypeOf(format),
        handled: false,
    };
}

export interface VirtualPayReconcileResult {
    checked: number;
    settled: number;
}

function firstQueryValue(
    value: string | string[] | undefined,
): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

/**
 * 小程序虚拟支付（道具直购）的计费实现。
 *
 * 与 JSAPI 通道的差别不只是「换个接口」：
 * - `outTradeNo` 每次下单必须重新生成（微信要求，复用报 -15002），所以下单
 *   尝试单独记在 `PaymentAttempt`，`Payment` 仍是「一单一结算记录」；
 * - 发货依据是平台推送 + `query_order` 兜底，**不收**前端 `success` 回调；
 * - 推送内容不能盲信：先用 `wx_order_id` 幂等，再用 `query_order` 反查金额与状态；
 * - 结算复用 `settlePaidOrder`，与 V3 通道共用订阅堆叠与通知逻辑。
 */
@Injectable()
export class WechatVirtualPaymentService implements RefundProvider {
    readonly channel = PaymentChannel.WECHAT_VIRTUAL;

    private readonly logger = new Logger(WechatVirtualPaymentService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly paymentService: PaymentService,
        private readonly notifications: NotificationsService,
        private readonly client: WechatVirtualPayClient,
        private readonly miniprogramClient: MiniprogramClient,
        private readonly runtimeConfig: WechatRuntimeConfigService,
        private readonly refunds: RefundService,
        private readonly plans: EffectivePlanService,
    ) {}

    /**
     * 下单：校验订单 → 换 sessionKey → 生成签名 payData → 记一条支付尝试。
     *
     * 前端拿到结果后直接 `wx.requestVirtualPayment(payData)`。
     */
    async createPayment(
        orderId: string,
        userId: string,
        dto: CreatePaymentDto,
    ): Promise<VirtualPayCreateResult> {
        const order = await this.paymentService.ensureOrderPayable(
            orderId,
            userId,
        );
        await this.paymentService.assertChannelSwitchable(
            order.id,
            PaymentChannel.WECHAT_VIRTUAL,
        );

        const code = dto.code?.trim();
        if (!code) {
            throw new BadRequestException({
                code: 'MINIPROGRAM_CODE_REQUIRED',
                message:
                    'wx.login() code is required for the virtual payment channel',
            });
        }

        const identity = await this.prisma.userIdentity.findFirst({
            where: { userId, provider: IdentityProvider.WECHAT_MINI },
            select: { openid: true },
        });

        if (!identity) {
            throw new BadRequestException({
                code: 'MINIPROGRAM_NOT_BOUND',
                message:
                    'This account is not bound to a mini-program identity (log in from the mini program first)',
            });
        }

        const session = await this.exchangeCode(code);

        if (session.openid !== identity.openid) {
            throw new BadRequestException({
                code: 'MINIPROGRAM_OPENID_MISMATCH',
                message:
                    'The supplied code belongs to a different mini-program user',
            });
        }

        const productId = await this.resolveProductId(order);
        const outTradeNo = this.generateOutTradeNo();
        const payData = await this.client.buildPayData({
            productId,
            goodsPrice: order.amount,
            outTradeNo,
            attach: order.orderNo,
            sessionKey: session.sessionKey,
        });
        const { env } = await this.client.credentials();

        await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${order.organizationId} FOR UPDATE`;
            await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
            const current = await tx.order.findUniqueOrThrow({
                where: { id: order.id },
            });
            const payment = await tx.payment.findUnique({
                where: { orderId: order.id },
            });
            if (
                current.status !== OrderStatus.PENDING ||
                current.expiresAt <= new Date() ||
                payment?.status === PaymentStatus.SUCCESS ||
                payment?.status === PaymentStatus.REFUNDED
            ) {
                throw new BadRequestException('Order is no longer payable');
            }
            await tx.paymentAttempt.create({
                data: {
                    orderId: order.id,
                    channel: PaymentChannel.WECHAT_VIRTUAL,
                    outTradeNo,
                    openid: identity.openid,
                    productId,
                    amount: order.amount,
                    env,
                    status: PaymentAttemptStatus.PENDING,
                },
            });
        });

        return {
            channel: PaymentChannel.WECHAT_VIRTUAL,
            outTradeNo,
            ...payData,
        };
    }

    /**
     * MP 后台保存【消息推送】地址时的 GET 校验。
     *
     * 微信会带 `signature` / `timestamp` / `nonce` / `echostr` 发一个 GET，
     * 要求**原样返回 `echostr`**（不能包 JSON、不能加引号）。没配置
     * `pushToken` 时（本地联调）直接回显；配置了就必须验签，否则任何人都能
     * 把你的推送地址挂到自己的小程序上。
     */
    async verifyPushUrl(params: {
        query: Record<string, string | string[] | undefined>;
    }): Promise<{ ok: boolean; body: string }> {
        const echostr = firstQueryValue(params.query['echostr']) ?? '';
        const config = await this.runtimeConfig.virtualPay();

        if (!config.pushToken) {
            return { ok: true, body: echostr };
        }

        const ok = checkSignature(
            config.pushToken,
            firstQueryValue(params.query['timestamp']) ?? '',
            firstQueryValue(params.query['nonce']) ?? '',
            firstQueryValue(params.query['signature']) ?? '',
        );

        return ok
            ? { ok: true, body: echostr }
            : { ok: false, body: 'invalid signature' };
    }

    /**
     * 处理 MP 后台【消息推送】转来的虚拟支付推送。
     *
     * 无论内部发生什么都要给出**合法应答**：成功返回 `ErrCode = 0`，失败
     * 返回非 0 让平台重试（最多 15 次）。已发货的重复推送必须回 0，否则会
     * 被反复重试。
     */
    async handleNotify(params: {
        rawBody: string;
        query: Record<string, string | string[] | undefined>;
    }): Promise<VirtualPayNotifyResult> {
        // 推送格式由 MP 后台【消息推送 → 数据格式】决定。本项目统一用 JSON；
        // XML 只在 body 以 `<` 开头时兜底，避免后台还没切就静默丢单。
        const format = detectPushFormat(params.rawBody);

        let root: Record<string, unknown>;

        try {
            root = parsePushPayload(params.rawBody, format);
            root = await this.unwrapSafeMode(root, params.query, format);
        } catch (error) {
            this.logger.warn(
                `Rejecting virtual payment notify: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );

            return failResult(format, 'invalid payload');
        }

        const event = readXpayEvent(root);

        if (event === VIRTUAL_PAY_EVENTS.refund) {
            return this.handleRefundNotify(root, params.rawBody, format);
        }

        if (event !== VIRTUAL_PAY_EVENTS.goodsDeliver) {
            // 代币支付、投诉、风控等推送本系统暂不处理，但必须回 0 免得被重试。
            this.logger.debug(
                `Ignoring virtual payment event: ${event || '(none)'}`,
            );

            return successResult(format, false);
        }

        try {
            const notify = parseDeliverNotify(root);
            const outcome = await this.settleDeliverNotify(
                notify,
                params.rawBody,
            );

            return successResult(format, outcome);
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            this.logger.error(
                `Virtual payment deliver notify failed: ${message}`,
            );

            return failResult(format, message);
        }
    }

    /**
     * 兜底查单：推送丢失时把「已支付但没发货」的尝试补上。
     *
     * 与推送走同一个结算入口，因此幂等行为完全一致。由 cron 每 5 分钟调用。
     */
    async reconcilePendingAttempts(): Promise<VirtualPayReconcileResult> {
        if (await this.client.isMock()) {
            return { checked: 0, settled: 0 };
        }

        const attempts = await this.prisma.paymentAttempt.findMany({
            where: {
                channel: PaymentChannel.WECHAT_VIRTUAL,
                status: PaymentAttemptStatus.PENDING,
                createdAt: { gt: new Date(Date.now() - RECONCILE_LOOKBACK_MS) },
            },
            include: { order: true },
            orderBy: { createdAt: 'asc' },
            take: RECONCILE_BATCH_SIZE,
        });

        let settled = 0;

        for (const attempt of attempts) {
            try {
                const remote = await this.client.queryOrder({
                    openid: attempt.openid,
                    outTradeNo: attempt.outTradeNo,
                    env: attempt.env === 1 ? 1 : 0,
                });

                if (!isVirtualPayPaid(remote.status)) {
                    continue;
                }

                const outcome = await this.settleAttempt(attempt, {
                    wxOrderId: remote.wxOrderId,
                    paidAt: remote.paidTime
                        ? new Date(remote.paidTime * 1000)
                        : new Date(),
                    paidFee: remote.paidFee,
                    rawPayload: { source: 'query_order', order: remote },
                });

                if (outcome.settled) settled += 1;
            } catch (error) {
                this.logger.warn(
                    `Reconcile failed for ${attempt.outTradeNo}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

        return { checked: attempts.length, settled };
    }

    // -- 发货 -------------------------------------------------------------

    private async settleDeliverNotify(
        notify: ReturnType<typeof parseDeliverNotify>,
        rawBody: string,
    ): Promise<boolean> {
        const attempt = await this.findAttempt(notify);

        if (!attempt) {
            throw new Error(`No order for outTradeNo ${notify.outTradeNo}`);
        }

        if (attempt.status === PaymentAttemptStatus.PAID) {
            return false;
        }

        // 金额必须与下单时一致：不一致说明道具价格被改过或推送被伪造，
        // 宁可让平台重试/人工介入，也不能按错误金额发货。
        const paidFee = notify.actualPrice ?? null;
        if (paidFee !== null && paidFee !== attempt.amount) {
            this.logger.error(
                `Amount mismatch for ${notify.outTradeNo}: expected ${attempt.amount}, notify says ${paidFee}`,
            );

            throw new Error('amount mismatch');
        }

        const verified = await this.verifyWithQueryOrder(
            attempt,
            notify.wxOrderId,
        );

        if (!verified) {
            throw new Error('order is not paid according to query_order');
        }

        const outcome = await this.settleAttempt(attempt, {
            wxOrderId: notify.wxOrderId ?? verified.wxOrderId,
            paidAt: notify.paidTime
                ? new Date(notify.paidTime * 1000)
                : new Date(),
            paidFee,
            rawPayload: { source: 'deliver_notify', payload: rawBody },
        });

        return outcome.settled;
    }

    /**
     * 用 `query_order` 反查这笔推送是否真的付过钱。
     *
     * 推送 URL 只能靠 MP 后台配置 + 可选验签保护，所以钱的事实以服务端查单
     * 为准；查单本身失败时退回「推送内容 + 金额已核对」继续（推送是官方主
     * 依据，不能因为微信接口抖动就丢掉一笔已付款订单），但会留下告警日志。
     */
    private async verifyWithQueryOrder(
        attempt: AttemptWithOrder,
        notifyWxOrderId: string | null,
    ): Promise<{ wxOrderId: string | null } | null> {
        if (await this.client.isMock()) {
            return { wxOrderId: notifyWxOrderId };
        }

        try {
            const remote = await this.client.queryOrder({
                openid: attempt.openid,
                outTradeNo: attempt.outTradeNo,
                env: attempt.env === 1 ? 1 : 0,
            });

            if (!isVirtualPayPaid(remote.status)) {
                this.logger.error(
                    `Rejected deliver notify for ${attempt.outTradeNo}: query_order status ${remote.status}`,
                );

                return null;
            }

            if (remote.paidFee !== null && remote.paidFee !== attempt.amount) {
                this.logger.error(
                    `Rejected deliver notify for ${attempt.outTradeNo}: paid ${remote.paidFee} != ${attempt.amount}`,
                );

                return null;
            }

            return { wxOrderId: remote.wxOrderId ?? notifyWxOrderId };
        } catch (error) {
            this.logger.warn(
                `query_order failed for ${attempt.outTradeNo}, falling back to the notify: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );

            return { wxOrderId: notifyWxOrderId };
        }
    }

    /**
     * 把一笔「确认已支付」的尝试结算成订阅。
     *
     * 幂等分两层：`PaymentAttempt.status` 用条件更新抢占（重复推送 / 并发
     * 查单只有一个赢家），`Payment` 的唯一 orderId 保证一个订单只激活一次。
     */
    private async settleAttempt(
        attempt: AttemptWithOrder,
        params: {
            wxOrderId: string | null;
            paidAt: Date;
            paidFee: number | null;
            rawPayload: unknown;
        },
    ): Promise<{ settled: boolean; duplicate: boolean }> {
        const { order } = attempt;

        // 兜底查单路径也要核对金额：道具价格被改过时不能按新价发货。
        if (params.paidFee !== null && params.paidFee !== attempt.amount) {
            throw new Error(
                `amount mismatch for ${attempt.outTradeNo}: expected ${attempt.amount}, got ${params.paidFee}`,
            );
        }

        try {
            return await this.prisma.$transaction(async (tx) => {
                await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${order.organizationId} FOR UPDATE`;
                await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
                const currentOrder = await tx.order.findUniqueOrThrow({
                    where: { id: order.id },
                });
                const claimed = await tx.paymentAttempt.updateMany({
                    where: {
                        id: attempt.id,
                        status: { not: PaymentAttemptStatus.PAID },
                    },
                    data: {
                        status: PaymentAttemptStatus.PAID,
                        wxOrderId: params.wxOrderId,
                        paidAt: params.paidAt,
                        rawNotify: params.rawPayload as Prisma.InputJsonValue,
                    },
                });

                if (claimed.count === 0) {
                    return { settled: false, duplicate: false };
                }

                if (
                    currentOrder.status !== OrderStatus.PENDING &&
                    currentOrder.status !== OrderStatus.PAID
                ) {
                    await tx.paymentAttempt.updateMany({
                        where: { id: attempt.id },
                        data: {
                            lastError: `Order is ${currentOrder.status}; manual refund required`,
                        },
                    });
                    await this.notifyAdminsAboutDuplicatePayment(
                        tx,
                        order,
                        attempt.outTradeNo,
                    );
                    return { settled: false, duplicate: true };
                }

                const payment = await this.ensurePayment(tx, currentOrder, {
                    ...params,
                    outTradeNo: attempt.outTradeNo,
                });

                if (!payment) {
                    return { settled: false, duplicate: true };
                }

                await settlePaidOrder(tx, {
                    order: currentOrder,
                    paymentId: payment.id,
                    notifications: this.notifications,
                });
                await this.plans.getEffectivePlanInTransaction(
                    order.organizationId,
                    tx,
                );

                return { settled: true, duplicate: false };
            });
        } catch (error) {
            // 同一个 wx_order_id 被两条尝试记录命中（并发推送）→ 另一个已经赢了。
            if (this.isUniqueViolation(error)) {
                this.logger.log(
                    `Attempt ${attempt.outTradeNo} was settled concurrently`,
                );

                return { settled: false, duplicate: false };
            }

            throw error;
        }
    }

    /**
     * 找到（或创建）该订单的结算记录。
     *
     * 返回 `null` 表示这笔钱对应的订单**已经结算过**：用户为同一订单付了两次
     * （例如先后点了两次支付并都成功了），第二笔不能重复激活订阅，只记录告警
     * 供人工退款。
     */
    private async ensurePayment(
        tx: Prisma.TransactionClient,
        order: OrderModel,
        params: {
            wxOrderId: string | null;
            paidAt: Date;
            rawPayload: unknown;
            outTradeNo: string;
        },
    ): Promise<{ id: string } | null> {
        const existing = await tx.payment.findUnique({
            where: { orderId: order.id },
        });

        if (
            existing?.status === PaymentStatus.SUCCESS ||
            order.status === OrderStatus.PAID
        ) {
            if (existing?.outTradeNo !== params.outTradeNo) {
                this.logger.error(
                    `Duplicate payment for order ${order.orderNo}: got ${params.outTradeNo}; manual refund required`,
                );
                await this.notifyAdminsAboutDuplicatePayment(
                    tx,
                    order,
                    params.outTradeNo,
                );
            }

            return null;
        }

        if (existing) {
            return tx.payment.update({
                where: { id: existing.id },
                data: {
                    channel: PaymentChannel.WECHAT_VIRTUAL,
                    transactionId: params.wxOrderId,
                    outTradeNo: params.outTradeNo,
                    status: PaymentStatus.SUCCESS,
                    paidAt: params.paidAt,
                    rawCallback: params.rawPayload as Prisma.InputJsonValue,
                },
                select: { id: true },
            });
        }

        return tx.payment.create({
            data: {
                orderId: order.id,
                channel: PaymentChannel.WECHAT_VIRTUAL,
                transactionId: params.wxOrderId,
                outTradeNo: params.outTradeNo,
                amount: order.amount,
                status: PaymentStatus.SUCCESS,
                paidAt: params.paidAt,
                rawCallback: params.rawPayload as Prisma.InputJsonValue,
            },
            select: { id: true },
        });
    }

    /** 重复支付必须让人看见：给订单所有者与组织管理员发站内通知 + 邮件。 */
    private async notifyAdminsAboutDuplicatePayment(
        tx: Prisma.TransactionClient,
        order: OrderModel,
        wxOrderId: string,
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
                eventKey: `payment-duplicate:${order.id}:${wxOrderId}`,
                type: 'PAYMENT_SUCCEEDED',
                accessScope: 'ORGANIZATION',
                title: 'Duplicate payment detected',
                body: `Order ${order.orderNo} was paid more than once (latest ${wxOrderId}). A manual refund is required.`,
                organizationId: order.organizationId,
                recipients,
                includeActor: true,
                email: true,
                resourceType: 'Order',
                resourceId: order.id,
            },
            tx,
        );
    }

    // -- 退款 -------------------------------------------------------------

    /**
     * 退款推送（`xpay_refund_notify`）。
     *
     * 只落账（订单 / 支付置为 REFUNDED）并发通知，**不自动收回订阅**：
     * iOS 退款由 Apple 侧发起、也可能是部分退款，自动扣掉权益容易误伤正常
     * 用户。订阅回收交给运营在后台处理。
     */
    private async handleRefundNotify(
        root: Record<string, unknown>,
        rawBody: string,
        format: PushFormat,
    ): Promise<VirtualPayNotifyResult> {
        try {
            const notify = parseRefundNotify(root);
            const attempt = await this.prisma.paymentAttempt.findUnique({
                where: { outTradeNo: notify.outTradeNo },
                include: { order: true },
            });

            if (!attempt) {
                this.logger.warn(
                    `Refund notify for unknown outTradeNo ${notify.outTradeNo}`,
                );

                return successResult(format, false);
            }

            const payment = await this.prisma.payment.findUnique({
                where: { orderId: attempt.orderId },
            });

            const winner = await this.findRefundableAttempt(attempt.orderId);
            if (
                attempt.channel !== PaymentChannel.WECHAT_VIRTUAL ||
                winner?.outTradeNo !== attempt.outTradeNo
            ) {
                this.logger.warn(
                    `Refund for non-settling attempt ${notify.outTradeNo}; manual reconciliation required`,
                );
                return successResult(format, false);
            }

            if (payment?.status === PaymentStatus.REFUNDED) {
                return successResult(format, false);
            }

            const outcome = await this.prisma.$transaction(async (tx) => {
                await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${attempt.order.organizationId} FOR UPDATE`;
                const currentPayment = await tx.payment.findUnique({
                    where: { orderId: attempt.orderId },
                });
                const currentOrder = await tx.order.findUniqueOrThrow({
                    where: { id: attempt.orderId },
                });
                if (
                    currentPayment?.status === PaymentStatus.REFUNDED ||
                    currentOrder.status === OrderStatus.REFUNDED
                )
                    return { handled: false };
                // Approval and passive refunds share the tenant lock. An Apple
                // refund cannot implicitly approve a waiting local request.
                const inFlightRefund = await tx.refund.findFirst({
                    where: {
                        orderId: attempt.orderId,
                        status: {
                            in: [RefundStatus.PENDING, RefundStatus.PROCESSING],
                        },
                    },
                });
                if (inFlightRefund?.submittedAt)
                    return { submittedRefundId: inFlightRefund.id };
                // Apple 侧发起的退款没有本地申请记录，金额以推送为准。
                const refundAmount = notify.refundFee ?? attempt.amount;
                if (
                    !Number.isSafeInteger(refundAmount) ||
                    refundAmount <= 0 ||
                    refundAmount >
                        currentOrder.amount - currentOrder.refundedAmount ||
                    !currentPayment ||
                    refundAmount >
                        currentPayment.amount - currentPayment.refundedAmount
                ) {
                    throw new Error('Refund exceeds the remaining paid amount');
                }
                if (inFlightRefund)
                    await tx.refund.update({
                        where: { id: inFlightRefund.id },
                        data: {
                            status: RefundStatus.CLOSED,
                            failureReason:
                                'Superseded by an external refund; subscription requires manual review',
                        },
                    });

                if (payment) {
                    await tx.payment.update({
                        where: { id: payment.id },
                        data: {
                            status: PaymentStatus.REFUNDED,
                            refundedAmount: { increment: refundAmount },
                            rawCallback: {
                                refund: rawBody,
                            },
                        },
                    });
                }

                await tx.order.update({
                    where: { id: attempt.orderId },
                    data: {
                        status: OrderStatus.REFUNDED,
                        refundedAmount: { increment: refundAmount },
                    },
                });

                // 补一条被动退款记录：让对账报表与后台列表能看到 Apple 发起的
                // 退款（这类退款不回收订阅，见方法注释）。
                await tx.refund.create({
                    data: {
                        refundNo: generateRefundNo(),
                        orderId: attempt.orderId,
                        organizationId: attempt.order.organizationId,
                        channel: PaymentChannel.WECHAT_VIRTUAL,
                        type: RefundType.MANUAL,
                        status: RefundStatus.SUCCESS,
                        amount: refundAmount,
                        settledAmount: refundAmount,
                        policyCode: 'MANUAL',
                        reason: 'WeChat virtual payment refund notify',
                        approvedBy: null,
                        channelRefundId: notify.refundId ?? null,
                        refundedAt: new Date(),
                        rawResponse: {
                            source: 'xpay_refund_notify',
                            rawBody: rawBody.slice(0, 2000),
                        },
                    },
                });

                await tx.paymentAttempt.updateMany({
                    where: { id: attempt.id },
                    data: { status: PaymentAttemptStatus.CLOSED },
                });

                const recipients = [
                    attempt.order.userId,
                    ...(await this.notifications.organizationRecipients(
                        attempt.order.organizationId,
                        tx,
                        ADMIN_ROLES,
                    )),
                ];

                await this.notifications.publish(
                    {
                        eventKey: `payment-refunded:${attempt.orderId}:${notify.refundId ?? notify.outTradeNo}`,
                        type: 'PAYMENT_SUCCEEDED',
                        accessScope: 'ORGANIZATION',
                        title: 'Payment refunded',
                        body: `Order ${attempt.order.orderNo} was refunded${
                            notify.refundFee ? ` (${notify.refundFee} 分)` : ''
                        }. Review the subscription if the refund was not expected.`,
                        organizationId: attempt.order.organizationId,
                        recipients,
                        includeActor: true,
                        email: true,
                        resourceType: 'Order',
                        resourceId: attempt.orderId,
                    },
                    tx,
                );
                return { handled: true };
            });

            if (outcome.submittedRefundId) {
                await this.refunds.markSuccess(outcome.submittedRefundId, {
                    status: 'SUCCESS',
                    channelRefundId: notify.refundId ?? undefined,
                    refundFee: notify.refundFee ?? undefined,
                    raw: { source: 'xpay_refund_notify' },
                });
                return successResult(format, true);
            }
            if (!outcome.handled) return successResult(format, false);

            this.logger.log(
                `Refund recorded for ${notify.outTradeNo} (${notify.refundFee ?? 'unknown'} 分)`,
            );

            return successResult(format, true);
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            this.logger.error(`Refund notify failed: ${message}`);

            return failResult(format, message);
        }
    }

    // -- 解析 -------------------------------------------------------------

    /**
     * 安全模式（`Encrypt`）下先解密；明文模式原样返回。
     *
     * 验签只是纵深防御：`pushToken` / `pushAesKey` 未配置时跳过，真正的
     * 事实校验在 `verifyWithQueryOrder`（服务端查单）。
     */
    private async unwrapSafeMode(
        root: Record<string, unknown>,
        query: Record<string, string | string[] | undefined>,
        format: PushFormat,
    ): Promise<Record<string, unknown>> {
        const config = await this.runtimeConfig.virtualPay();
        const encrypted =
            typeof root['Encrypt'] === 'string' ? root['Encrypt'] : null;

        if (!encrypted) {
            if (config.pushToken) {
                const ok = checkSignature(
                    config.pushToken,
                    firstQueryValue(query['timestamp']) ?? '',
                    firstQueryValue(query['nonce']) ?? '',
                    firstQueryValue(query['signature']) ?? '',
                );

                if (!ok) {
                    throw new Error('signature mismatch');
                }
            }

            return root;
        }

        if (!config.pushAesKey) {
            throw new Error(
                'received an encrypted notify but wechat.virtualPay.pushAesKey is not configured',
            );
        }

        if (config.pushToken) {
            const ok = checkMsgSignature(
                config.pushToken,
                firstQueryValue(query['timestamp']) ?? '',
                firstQueryValue(query['nonce']) ?? '',
                encrypted,
                firstQueryValue(query['msg_signature']) ?? '',
            );

            if (!ok) {
                throw new Error('msg_signature mismatch');
            }
        }

        const { appId } = await this.runtimeConfig.miniprogram();
        const plaintext = decryptMessage(encrypted, config.pushAesKey, appId);

        return parsePushPayload(plaintext, format);
    }

    private async findAttempt(notify: {
        outTradeNo: string;
        openId: string;
        productId: string | null;
        actualPrice: number | null;
        env: number;
        attach: string | null;
    }): Promise<AttemptWithOrder | null> {
        const attempt = await this.prisma.paymentAttempt.findUnique({
            where: { outTradeNo: notify.outTradeNo },
            include: { order: true },
        });

        if (attempt)
            return attempt.channel === PaymentChannel.WECHAT_VIRTUAL
                ? attempt
                : null;

        // 尝试记录丢了（例如推送先于下单落库、或跨环境重放）：用 attach
        // （= orderNo）找回订单并补一条尝试，保证之后还能按 wx_order_id 幂等。
        if (notify.attach) {
            const order = await this.prisma.order.findFirst({
                where: { orderNo: notify.attach },
            });

            if (!order) return null;

            this.logger.warn(
                `Deliver notify for ${notify.outTradeNo} had no payment attempt; recreating one from order ${order.orderNo}`,
            );

            return this.prisma.paymentAttempt.create({
                data: {
                    orderId: order.id,
                    channel: PaymentChannel.WECHAT_VIRTUAL,
                    outTradeNo: notify.outTradeNo,
                    openid: notify.openId,
                    productId: notify.productId,
                    amount: notify.actualPrice ?? order.amount,
                    env: notify.env,
                    status: PaymentAttemptStatus.PENDING,
                },
                include: { order: true },
            });
        }

        return null;
    }

    private async exchangeCode(
        code: string,
    ): Promise<{ openid: string; sessionKey: string }> {
        const { appId, appSecret } = await this.runtimeConfig.miniprogram();

        if (!appId || !appSecret) {
            throw new BadRequestException({
                code: 'MINIPROGRAM_NOT_CONFIGURED',
                message:
                    'WeChat mini program credentials are missing (WECHAT_MINI_APPID / WECHAT_MINI_APPSECRET)',
            });
        }

        const session = await this.miniprogramClient.code2Session({
            appId,
            appSecret,
            code,
        });

        return { openid: session.openid, sessionKey: session.sessionKey };
    }

    /** 找到该订单档位对应的微信道具 ID，并核对价格快照。 */
    private async resolveProductId(order: OrderModel): Promise<string> {
        const term = order.termId
            ? await this.prisma.planTerm.findUnique({
                  where: { id: order.termId },
              })
            : order.cycle
              ? await this.prisma.planTerm.findFirst({
                    where: { planId: order.planId, cycle: order.cycle },
                })
              : null;

        if (!term?.wechatProductId) {
            throw new BadRequestException({
                code: 'VIRTUAL_PRODUCT_NOT_MAPPED',
                message:
                    'This plan term has no WeChat virtual product id yet; ask an admin to map one (and publish the product in the MP console)',
            });
        }

        if (term.price !== order.amount) {
            throw new BadRequestException({
                code: 'VIRTUAL_PRODUCT_PRICE_MISMATCH',
                message: `Term price ${term.price} does not match the order amount ${order.amount}`,
            });
        }

        return term.wechatProductId;
    }

    // -- 退款（RefundProvider）------------------------------------------

    /**
     * 发起虚拟支付退款（`/xpay/refund_order`）。
     *
     * 这个接口只是「启动退款任务」，返回后状态是 `PROCESSING`；终态由
     * `xpay_refund_notify` 推送或 `queryRefund` 的 `query_order` 反查确认。
     *
     * iOS 上用户也可能直接向 Apple 申请退款，那条路不经过这里，只能被动落账
     * （见 `handleRefundNotify`）。
     */
    async refund(
        input: PaymentProviderRefundInput,
    ): Promise<PaymentProviderRefundResult> {
        const attempt = await this.findRefundableAttempt(input.orderId);

        if (!attempt) {
            throw new BadRequestException(
                'No paid virtual payment attempt for this order',
            );
        }

        if (await this.client.isMock()) {
            return { status: 'SUCCESS', raw: { mock: true } };
        }

        const { env } = await this.client.credentials();

        // 微信 `/xpay/refund_order` 的 `refund_reason` 只接受 0-5 枚举，不接受
        // 自由文本（传自由文本会报 268490002）。内部自由文本原因无法可靠归类到
        // 微信的 6 个枚举，统一上送「其他原因」；原文仍保存在 `Refund.reason`。
        await this.client.refundOrder({
            openid: attempt.openid,
            outTradeNo: attempt.outTradeNo,
            env,
            refundOrderId: input.outRefundNo,
            leftFee: input.leftFee ?? input.totalFee,
            refundFee: input.refundFee,
            bizMeta: input.outTradeNo,
            reason: VIRTUAL_PAY_REFUND_REASONS.OTHER,
            // 系统目前不区分退款是客服发起还是用户自助，统一「其它」。
            reqFrom: VIRTUAL_PAY_REFUND_REQ_FROM.OTHER,
        });

        return {
            status: 'PROCESSING',
            raw: { outTradeNo: attempt.outTradeNo },
        };
    }

    /** 退款推送丢失时用 `query_order` 反查退款终态。 */
    async queryRefund(input: {
        refundNo: string;
        outTradeNo: string;
        orderId?: string;
    }): Promise<PaymentProviderRefundResult> {
        const attempt = await this.findRefundableAttempt(input.orderId);

        if (!attempt) {
            // 找不到支付尝试只能继续等：判失败会让兜底轮询把正常退款标成失败
            return {
                status: 'PROCESSING',
                raw: { reason: 'payment attempt not found' },
            };
        }

        if (await this.client.isMock()) {
            return { status: 'SUCCESS', raw: { mock: true } };
        }

        const { env } = await this.client.credentials();
        const remote = await this.client.queryOrder({
            openid: attempt.openid,
            outTradeNo: attempt.outTradeNo,
            env,
        });

        return mapVirtualRefundStatus(remote);
    }

    /** 虚拟支付退款的入参是「支付尝试」而不是订单：单号与 openid 都在这里。 */
    private async findRefundableAttempt(orderId?: string) {
        if (!orderId) return null;

        const payment = await this.prisma.payment.findUnique({
            where: { orderId },
        });
        if (!payment || payment.channel !== PaymentChannel.WECHAT_VIRTUAL)
            return null;
        const identity = payment.outTradeNo
            ? { outTradeNo: payment.outTradeNo }
            : payment.transactionId
              ? { wxOrderId: payment.transactionId }
              : null;
        if (!identity) return null;

        return this.prisma.paymentAttempt.findFirst({
            where: {
                orderId,
                channel: PaymentChannel.WECHAT_VIRTUAL,
                status: PaymentAttemptStatus.PAID,
                ...identity,
            },
            select: { outTradeNo: true, openid: true },
        });
    }

    /**
     * 生成业务单号：8-32 位、不以 `_` 开头、每次下单都不同。
     * 用 `V` 前缀区分虚拟支付单号，方便在微信后台与 V3 单号区分。
     */
    private generateOutTradeNo(): string {
        const timestamp = Date.now().toString(36).toUpperCase();
        const random = randomBytes(5).toString('hex').toUpperCase();

        return `V${timestamp}${random}`;
    }

    private isUniqueViolation(error: unknown): boolean {
        return (
            typeof error === 'object' &&
            error !== null &&
            (error as { code?: string }).code === 'P2002'
        );
    }
}

/**
 * `query_order` 的退款状态 → 平台退款状态。
 *
 * 虚拟支付没有独立退款单号，也没有单独的退款状态字段：退款单在 `query_order`
 * 里复用订单状态（5 = 商户侧退款完成、8 = 用户侧到账、7 = 退款失败）。
 */
function mapVirtualRefundStatus(
    remote: VirtualPayOrder,
): PaymentProviderRefundResult {
    if (remote.status === VIRTUAL_PAY_ORDER_STATUS.REFUND_FAILED) {
        return {
            status: 'FAILED',
            failureReason: 'WeChat virtual payment refund failed',
            raw: remote,
        };
    }

    if (
        remote.status === VIRTUAL_PAY_ORDER_STATUS.REFUND_MERCHANT_DONE ||
        remote.status === VIRTUAL_PAY_ORDER_STATUS.REFUND_USER_DONE
    ) {
        return { status: 'SUCCESS', raw: remote };
    }

    // Normal paid/delivery states contain no refund yet. A lost submission
    // response can be recovered with the SAME refund_order_id; the channel's
    // idempotency also covers a refund accepted after this query snapshot.
    const notFound = [
        VIRTUAL_PAY_ORDER_STATUS.PAID,
        VIRTUAL_PAY_ORDER_STATUS.DELIVERING,
        VIRTUAL_PAY_ORDER_STATUS.DELIVERED,
    ].some((status) => status === remote.status);
    return {
        status: 'PROCESSING',
        ...(notFound ? { notFound: true } : {}),
        raw: remote,
    };
}
