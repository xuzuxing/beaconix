/**
 * WeChat Pay V3 types.
 *
 * Docs: https://pay.weixin.qq.com/wiki/doc/apiv3/index.shtml
 */

/** Encrypted `resource` block carried by notifications and certificate list. */
export interface WechatPayEncryptedResource {
    algorithm: string;
    ciphertext: string;
    nonce: string;
    associated_data?: string;
    original_type?: string;
}

/** Outer envelope of a WeChat Pay V3 notification callback. */
export interface WechatPayNotificationEnvelope {
    id: string;
    create_time: string;
    event_type: string;
    resource_type: string;
    resource: WechatPayEncryptedResource;
    summary?: string;
}

/** Decrypted transaction payload (subset of the V3 transaction object). */
export interface WechatPayTransaction {
    out_trade_no: string;
    transaction_id: string;
    /** `SUCCESS` / `NOTPAY` / `CLOSED` / `REFUND` / `USERPAYING` / `PAYERROR`. */
    trade_state: string;
    trade_state_desc?: string;
    success_time?: string;
    attach?: string;
    amount?: {
        total?: number;
        payer_total?: number;
        currency?: string;
    };
    payer?: {
        openid?: string;
    };
    [key: string]: unknown;
}

/** Domestic refund object (subset). */
export interface WechatPayRefund {
    refund_id: string;
    out_refund_no: string;
    out_trade_no?: string;
    transaction_id?: string;
    /** 查询接口返回的执行状态：`SUCCESS` / `CLOSED` / `PROCESSING` / `ABNORMAL`。 */
    status: string;
    /** 退款结果通知（`/v3/refund/domestic/notifications`）里的状态字段。 */
    refund_status?: string;
    amount?: {
        total?: number;
        refund?: number;
        currency?: string;
    };
    [key: string]: unknown;
}

export interface WechatPayPlatformCertificate {
    serialNo: string;
    /** X.509 certificate in PEM form. */
    certificate: string;
}

export interface WechatPayCertificatesResponse {
    data: Array<{
        serial_no: string;
        effective_time?: string;
        expire_time?: string;
        encrypt_certificate: WechatPayEncryptedResource;
    }>;
}

export interface CreateJsapiTransactionInput {
    /** Shown on the WeChat payment sheet, e.g. "Beacon plan order BW123". */
    description: string;
    outTradeNo: string;
    /** Amount in fen (分). */
    totalFee: number;
    /** Payer openid (JSAPI/mini-program). */
    openid: string;
    /** Defaults to `WECHAT_PAY_NOTIFY_URL`. */
    notifyUrl?: string;
    timeExpire?: string;
    attach?: string;
}

export interface CreateRefundInput {
    outRefundNo: string;
    /** Provide either `outTradeNo` or `transactionId`. */
    outTradeNo?: string;
    transactionId?: string;
    /** Refund amount in fen (分). */
    refundFee: number;
    /** Original order amount in fen (分). */
    totalFee: number;
    reason?: string;
    /** Defaults to `WECHAT_PAY_NOTIFY_URL`. */
    notifyUrl?: string;
}

/** Params handed to `wx.requestPayment` on the client. */
export interface WechatJsapiPayParams {
    timeStamp: string;
    nonceStr: string;
    package: string;
    signType: 'RSA';
    paySign: string;
    [key: string]: unknown;
}

/** Header bag accepted from Express / Nest (`req.headers`). */
export type WechatPayHeaderBag = Record<string, string | string[] | undefined>;
