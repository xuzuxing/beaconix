/**
 * 支付宝支付接口的用词约定：
 *
 * - 金额一律是**元**的两位小数字符串（`'9.99'`）。订单侧 `Order.amount` 是分，
 *   换算发生在 `AlipayPaymentService`，本模块不处理分。
 * - 字段名沿用支付宝的下划线原始名（`out_trade_no` / `trade_status`），
 *   因为异步通知验签就是对这份参数字典做的；转成驼峰会让人误以为能改键。
 */

/** 收银台产品码。值就是支付宝的接口名，便于直接对照官方文档。 */
export enum AlipayPayMethod {
    /** PC 浏览器收银台（返回可 GET 跳转的 URL）。 */
    PAGE = 'alipay.trade.page.pay',
    /** 手机浏览器收银台（返回可 GET 跳转的 URL）。 */
    WAP = 'alipay.trade.wap.pay',
    /** 当面付/扫码：返回 `qr_code`（一串支付宝支付链接，由前端渲染成二维码）。 */
    PRECREATE = 'alipay.trade.precreate',
}

/** 产品码 → 接口要求随单上送的 `product_code`。 */
export const ALIPAY_PRODUCT_CODE: Record<AlipayPayMethod, string> = {
    [AlipayPayMethod.PAGE]: 'FAST_INSTANT_TRADE_PAY',
    [AlipayPayMethod.WAP]: 'QUICK_WAP_WAY',
    [AlipayPayMethod.PRECREATE]: 'FACE_TO_FACE_PAYMENT',
};

/** 支付宝认为「钱已到账」的交易状态（`TRADE_FINISHED` 只是不可退款，同样算成功）。 */
export const ALIPAY_SUCCESS_TRADE_STATUSES: readonly string[] = [
    'TRADE_SUCCESS',
    'TRADE_FINISHED',
];

/** 配置缺失或值不可用（缺 APPID/私钥、回调地址为空等）。 */
export class AlipayConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AlipayConfigurationError';
    }
}

/** 支付宝接口返回失败，或异步通知验签不通过。 */
export class AlipayApiError extends Error {
    constructor(
        message: string,
        readonly code?: string,
        readonly subCode?: string,
    ) {
        super(message);
        this.name = 'AlipayApiError';
    }
}

export interface AlipayOrder {
    /** 商户订单号（`out_trade_no`），用 `Order.orderNo`。 */
    outTradeNo: string;
    /** 订单金额，元的两位小数字符串，例如 `'9.99'`。 */
    totalAmount: string;
    /** 订单标题（`subject`），用户会在收银台看到。 */
    subject: string;
}

export interface AlipayCashierRequest extends AlipayOrder {
    /** 异步通知地址；留空则取 `alipay.notifyUrl` 配置。 */
    notifyUrl?: string;
    /** 支付完成后浏览器跳回的地址；留空则取 `alipay.returnUrl` 配置。 */
    returnUrl?: string;
}

export type AlipayPrecreateRequest = AlipayCashierRequest;

export interface AlipayPrecreateResult {
    /** 支付宝返回的支付链接，需要由前端生成二维码供用户扫码。 */
    qrCode: string;
}

/** 异步通知参数（form-urlencoded 解析后的字典）。 */
export type AlipayNotifyParams = Record<string, string>;

export interface AlipayRefundRequest {
    /** 原支付订单号（`Order.orderNo`）。 */
    outTradeNo: string;
    /** 平台退款单号，作为支付宝的 `out_request_no`（幂等键）。 */
    outRefundNo: string;
    /** 退款金额，元的两位小数字符串。 */
    refundAmount: string;
    reason?: string;
}

/**
 * `alipay.trade.refund` / `alipay.trade.fastpay.refund.query` 的关键字段。
 *
 * SDK 会把下划线字段转成驼峰（`fund_change` → `fundChange`），这里按驼峰声明。
 */
export interface AlipayRefundApiResult {
    /** `10000` 表示接口调用成功；业务是否真的退了钱看 `fundChange`。 */
    code: string;
    msg?: string;
    subCode?: string;
    subMsg?: string;
    /** `Y` = 本次发生了资金变动；`N` = 幂等重复请求（之前已退成功）。 */
    fundChange?: string;
    tradeNo?: string;
    outTradeNo?: string;
    /** 退款金额（元）。 */
    refundFee?: string;
    /** 查询接口返回：`REFUND_SUCCESS` 表示退款已成功。 */
    refundStatus?: string;
}
