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
}
