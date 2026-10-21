/**
 * 小程序虚拟支付（道具直购）协议类型。
 *
 * 文档：
 * - 接入指引（个人主体）https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/person.html
 * - 客户端 API https://developers.weixin.qq.com/miniprogram/dev/api/payment/wx.requestVirtualPayment.html
 * - 服务端接口 https://developers.weixin.qq.com/miniprogram/dev/server/API/VirtualPayment/api_query_order.html
 */

/** 0 = 现网，1 = 沙箱。现网部署只允许 0（否则微信报 -15011）。 */
export type WechatVirtualPayEnv = 0 | 1;

/** 道具直购。代币充值（`short_series_coin`）不在本项目的接入范围内。 */
export const VIRTUAL_PAY_MODE_GOODS = 'short_series_goods';

/** `signData` 的业务字段；`currencyType` 固定 CNY、`env` 由凭据决定。 */
export interface VirtualPaySignDataInput {
    offerId: string;
    buyQuantity: number;
    env: WechatVirtualPayEnv;
    productId: string;
    /** 道具单价（分），必须与 MP 后台道具价格一致，否则 -15013。 */
    goodsPrice: number;
    /** 商家业务单号：8-32 位、不以 `_` 开头、每次下单重新生成。 */
    outTradeNo: string;
    /** 透传数据，发货推送原样带回（我们放 orderNo）。 */
    attach: string;
}

/** `wx.requestVirtualPayment` 的入参（服务端签名后下发）。 */
export interface VirtualPayPayData {
    /** JSON **字符串**，字段顺序固定，签名必须基于这同一个字符串。 */
    signData: string;
    mode: typeof VIRTUAL_PAY_MODE_GOODS;
    /** HMAC-SHA256(appKey, `requestVirtualPayment&` + signData)。 */
    paySig: string;
    /** HMAC-SHA256(sessionKey, signData)。 */
    signature: string;
}

/** `query_order` 的订单状态（文档 `Res.order.status`）。 */
export const VIRTUAL_PAY_ORDER_STATUS = {
    /** 订单初始化（未创建成功，不可用于支付） */
    INIT: 0,
    /** 订单创建成功，未支付 */
    CREATED: 1,
    /** 已支付，待发货 */
    PAID: 2,
    /** 发货中 */
    DELIVERING: 3,
    /** 已发货 */
    DELIVERED: 4,
    /** 退款：商户侧扣款完成 */
    REFUND_MERCHANT_DONE: 5,
    /** 订单已关闭 */
    CLOSED: 6,
    /** 退款失败 */
    REFUND_FAILED: 7,
    /** 退款：用户侧收款完成 */
    REFUND_USER_DONE: 8,
    /** 回收广告金完成 */
    AD_RECLAIMED: 9,
    /** 分账回退完成 */
    PROFIT_SHARING_REVERSED: 10,
} as const;

/**
 * 视为「用户已经付钱」的状态。发货兜底查单只看这几个值：2/3/4 都是钱已到账，
 * 6（已关闭）与 0/1 都不能发货。
 */
export const VIRTUAL_PAY_PAID_STATUSES: readonly number[] = [
    VIRTUAL_PAY_ORDER_STATUS.PAID,
    VIRTUAL_PAY_ORDER_STATUS.DELIVERING,
    VIRTUAL_PAY_ORDER_STATUS.DELIVERED,
];

export function isVirtualPayPaid(status: number): boolean {
    return VIRTUAL_PAY_PAID_STATUSES.includes(status);
}

/** 发货推送 / 退款推送的事件名。 */
export const VIRTUAL_PAY_EVENTS = {
    goodsDeliver: 'xpay_goods_deliver_notify',
    coinPay: 'xpay_coin_pay_notify',
    refund: 'xpay_refund_notify',
} as const;

/** 解析后的发货推送（`xpay_goods_deliver_notify`）。 */
export interface VirtualPayDeliverNotify {
    openId: string;
    outTradeNo: string;
    env: number;
    /** 平台单号 `wx_order_id`（来自 `WeChatPayInfo.MchOrderNo`），幂等键。 */
    wxOrderId: string | null;
    /** 微信支付交易单号（来自 `WeChatPayInfo.TransactionId`）。 */
    transactionId: string | null;
    paidTime: number | null;
    productId: string | null;
    quantity: number;
    /** 道具原始价（分）。 */
    origPrice: number | null;
    /** 实际支付价（分）。 */
    actualPrice: number | null;
    attach: string | null;
}

/** 解析后的退款推送（`xpay_refund_notify`）。 */
export interface VirtualPayRefundNotify {
    openId: string;
    outTradeNo: string;
    env: number;
    wxOrderId: string | null;
    /** 微信支付退款单号。 */
    refundId: string | null;
    /** 退款金额（分）。 */
    refundFee: number | null;
    /** 原订单金额（分）。 */
    orderFee: number | null;
    refundTime: number | null;
    attach: string | null;
}

/** `query_order` 返回的订单（截取发货/对账用到的字段）。 */
export interface VirtualPayOrder {
    orderId: string;
    status: number;
    orderType: number | null;
    /** 订单金额（分）。 */
    orderFee: number | null;
    /** 用户实付金额（分）。 */
    paidFee: number | null;
    /** 已是退款单时为退款金额（分）。 */
    refundFee: number | null;
    wxOrderId: string | null;
    /** 支付/退款时间（unix 秒）。 */
    paidTime: number | null;
    /** 下发 attach 的原始值（文档 `biz_meta`）。 */
    bizMeta: string | null;
    envType: number | null;
}

export interface VirtualPayQueryOrderInput {
    openid: string;
    outTradeNo: string;
    env: WechatVirtualPayEnv;
}

export interface VirtualPayRefundOrderInput {
    openid: string;
    outTradeNo: string;
    env: WechatVirtualPayEnv;
    /** 退款金额（分）；不传则全额退。 */
    refundFee?: number;
    /** 退款原因，最长 80 字节。 */
    reason?: string;
}

export interface VirtualPayNotifyProvideGoodsInput {
    openid: string;
    outTradeNo: string;
    env: WechatVirtualPayEnv;
}
