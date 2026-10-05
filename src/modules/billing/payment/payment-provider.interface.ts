import type { PaymentChannel } from '../../../generated/prisma/enums';

export interface PaymentProviderCreateInput {
    outTradeNo: string;
    totalFee: number;
    /** Channel-specific payer identifier (e.g. WeChat openid). */
    payerId: string;
    body: string;
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

    /** Verifies and decodes an async payment callback body. */
    verifyCallback(
        rawBody: string,
        signature: string,
    ): Promise<PaymentProviderCallbackResult>;
}
