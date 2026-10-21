import type { PaymentChannel } from '../../../generated/prisma/enums';

export interface PaymentProviderCreateInput {
    outTradeNo: string;
    totalFee: number;
    /**
     * Channel-specific payer identifier (e.g. WeChat openid). Optional because
     * Alipay's page/wap/precreate flows have no payer identity at order time;
     * each provider validates what it actually needs.
     */
    payerId?: string;
    body: string;
    /** Channel-specific product/method selector (Alipay: page.pay / wap.pay / precreate). */
    payMethod?: string;
}

export interface PaymentProviderPayParams {
    [key: string]: unknown;
}

export interface PaymentProviderCallbackResult {
    out_trade_no: string;
    transaction_id: string;
    trade_state: string;
    [key: string]: unknown;
}

/** Header bag of the incoming callback request (Express `req.headers`). */
export type PaymentCallbackHeaders = Record<
    string,
    string | string[] | undefined
>;

export interface PaymentProviderRefundInput {
    /** 平台退款单号，同时是渠道幂等键（微信 `out_refund_no`、支付宝 `out_request_no`）。 */
    outRefundNo: string;
    /** 平台订单号（`Order.orderNo`），用于渠道侧定位原支付。 */
    outTradeNo: string;
    /** 平台订单 id：虚拟支付要靠它找 `PaymentAttempt`（openid + 真实单号）。 */
    orderId?: string;
    /** 渠道交易号（微信 `transaction_id`）。 */
    transactionId?: string;
    /** 退款金额（分）。 */
    refundFee: number;
    /** 原订单金额（分），微信要求上送用于校验。 */
    totalFee: number;
    reason?: string;
}

export type PaymentProviderRefundStatus = 'SUCCESS' | 'PROCESSING' | 'FAILED';

export interface PaymentProviderRefundResult {
    status: PaymentProviderRefundStatus;
    /** 渠道退款单号（微信 `refund_id`）。 */
    channelRefundId?: string;
    failureReason?: string;
    raw?: unknown;
}

/** 渠道退款结果通知解析后的内容。 */
export interface PaymentProviderRefundCallback extends PaymentProviderRefundResult {
    /** 渠道回传的平台退款单号（`out_refund_no`），用于定位本地记录。 */
    outRefundNo: string;
}

/**
 * 只具备退款能力的渠道。
 *
 * 虚拟支付（小程序道具）的下单走 `PaymentAttempt` + `wx.requestVirtualPayment`，
 * 与 `PaymentProvider` 的契约（返回 payParams）对不上，所以不实现完整接口，
 * 只单独登记退款能力，供 `RefundService` 统一调用。
 */
export interface RefundProvider {
    readonly channel: PaymentChannel;

    refund(
        input: PaymentProviderRefundInput,
    ): Promise<PaymentProviderRefundResult>;

    queryRefund?(input: {
        refundNo: string;
        outTradeNo: string;
        orderId?: string;
    }): Promise<PaymentProviderRefundResult>;
}

/**
 * A payment channel adapter. Add a new provider (Alipay, Stripe, ...) by
 * implementing this interface and registering it in PaymentProviderFactory.
 */
export interface PaymentProvider {
    readonly channel: PaymentChannel;

    /** Creates a payment order and returns channel-specific payment params. */
    createPayment(
        input: PaymentProviderCreateInput,
    ): Promise<PaymentProviderPayParams>;

    /**
     * Verifies and decodes an async payment callback body.
     *
     * `rawBody` must be the exact bytes the provider signed. Channels that
     * need more than the signature header (WeChat Pay V3 needs timestamp,
     * nonce and serial too) read them from `headers`.
     */
    verifyCallback(
        rawBody: string,
        signature: string,
        headers?: PaymentCallbackHeaders,
    ): Promise<PaymentProviderCallbackResult>;

    /**
     * Submits a refund to the channel.
     *
     * `PROCESSING` is a legitimate answer: WeChat confirms asynchronously and
     * Alipay can time out, so the caller must not treat it as failure.
     */
    refund(
        input: PaymentProviderRefundInput,
    ): Promise<PaymentProviderRefundResult>;

    /**
     * Re-reads a refund's state from the channel. Used by the reconcile job
     * when the callback never arrives (Alipay has no refund callback at all).
     */
    queryRefund?(input: {
        refundNo: string;
        outTradeNo: string;
        orderId?: string;
    }): Promise<PaymentProviderRefundResult>;

    /**
     * Parses a refund-result notification. Only channels that actually push
     * refund results implement it (WeChat does; Alipay answers synchronously).
     */
    parseRefundCallback?(
        rawBody: string,
        signature: string,
        headers?: PaymentCallbackHeaders,
    ): Promise<PaymentProviderRefundCallback>;
}
