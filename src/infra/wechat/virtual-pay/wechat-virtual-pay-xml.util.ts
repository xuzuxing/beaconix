import { XMLParser } from 'fast-xml-parser';
import type {
    VirtualPayDeliverNotify,
    VirtualPayRefundNotify,
} from './wechat-virtual-pay.types';
import { VIRTUAL_PAY_EVENTS } from './wechat-virtual-pay.types';

/**
 * 微信虚拟支付推送的 XML 解析与应答构造。
 *
 * 推送报文很小且结构固定（`<xml><Event>…` 加若干嵌套对象）。解析器按
 * 「不解析实体、不转换标量类型」配置：`processEntities: false` 直接关掉
 * 实体展开（XXE 的入口），`parseTagValue: false` 让金额/数量保持原文字符串，
 * 由调用方显式转换，避免 `"0"` 这类值被悄悄当成已支付。
 */
const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    /**
     * 必须显式声明 CDATA 的键名。不声明时，紧凑报文（`…]]></A><B>…`，微信
     * 实际推送就是这种）会把 `]]></A><B>` 之后的内容并进前一个标签的值，
     * 导致 `OutTradeNo` 里混入半截 XML、后续字段全部解析不出来。
     */
    cdataPropName: '__cdata',
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : undefined;
}

function pickString(value: unknown): string | null {
    if (value !== null && typeof value === 'object') {
        // CDATA 段落解析成 `{ __cdata: 'raw' }`（见 parser 的 cdataPropName）
        const record = value as Record<string, unknown>;
        return '__cdata' in record ? pickString(record['__cdata']) : null;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed === '' ? null : trimmed;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }

    return null;
}

function pickNumber(value: unknown): number | null {
    const raw = pickString(value);
    if (raw === null) return null;

    const parsed = Number(raw);

    return Number.isFinite(parsed) ? parsed : null;
}

/** 解析推送 XML，返回根节点（`<xml>` 的内容）。非法 XML 抛错。 */
export function parseXpayXml(xml: string): Record<string, unknown> {
    const parsed = asRecord(parser.parse(xml));
    const root = asRecord(parsed?.['xml']);

    if (!root) {
        throw new Error(
            'Unrecognised WeChat virtual payment payload (no <xml>)',
        );
    }

    return root;
}

/** 推送事件名（`Event`），缺失时为空串。 */
export function readXpayEvent(root: Record<string, unknown>): string {
    return pickString(root['Event']) ?? '';
}

/**
 * 解析发货推送 `xpay_goods_deliver_notify`。
 *
 * 幂等键是 `WeChatPayInfo.MchOrderNo`（= 平台单号 `wx_order_id`）；`GoodsInfo`
 * 里的数量/金额用于与本地订单核对。
 */
export function parseDeliverNotify(
    root: Record<string, unknown>,
): VirtualPayDeliverNotify {
    const payInfo = asRecord(root['WeChatPayInfo']);
    const goodsInfo = asRecord(root['GoodsInfo']);
    const outTradeNo = pickString(root['OutTradeNo']);

    if (!outTradeNo) {
        throw new Error('Deliver notify is missing OutTradeNo');
    }

    return {
        openId: pickString(root['OpenId']) ?? '',
        outTradeNo,
        env: pickNumber(root['Env']) ?? 0,
        wxOrderId: pickString(payInfo?.['MchOrderNo']),
        transactionId: pickString(payInfo?.['TransactionId']),
        paidTime: pickNumber(payInfo?.['PaidTime']),
        productId: pickString(goodsInfo?.['ProductId']),
        quantity: pickNumber(goodsInfo?.['Quantity']) ?? 1,
        origPrice: pickNumber(goodsInfo?.['OrigPrice']),
        actualPrice: pickNumber(goodsInfo?.['ActualPrice']),
        attach: pickString(goodsInfo?.['Attach']) ?? pickString(root['Attach']),
    };
}

/** 解析退款推送 `xpay_refund_notify`。/ 解析退款推送（`xpay_refund_notify`）。 */
export function parseRefundNotify(
    root: Record<string, unknown>,
): VirtualPayRefundNotify {
    const refundInfo =
        asRecord(root['RefundInfo']) ?? asRecord(root['WeChatPayInfo']);
    const outTradeNo = pickString(root['OutTradeNo']);

    if (!outTradeNo) {
        throw new Error('Refund notify is missing OutTradeNo');
    }

    return {
        openId: pickString(root['OpenId']) ?? '',
        outTradeNo,
        env: pickNumber(root['Env']) ?? 0,
        wxOrderId:
            pickString(refundInfo?.['MchOrderNo']) ??
            pickString(refundInfo?.['WxOrderId']),
        refundId:
            pickString(refundInfo?.['RefundId']) ??
            pickString(root['RefundId']),
        refundFee:
            pickNumber(refundInfo?.['RefundFee']) ??
            pickNumber(root['RefundFee']),
        orderFee:
            pickNumber(refundInfo?.['OrderFee']) ??
            pickNumber(root['OrderFee']),
        refundTime:
            pickNumber(refundInfo?.['RefundTime']) ??
            pickNumber(root['RefundTime']),
        attach: pickString(root['Attach']),
    };
}

/**
 * 成功应答。格式必须是 XML（推送是 XML 时），否则平台会重试最多 15 次。
 * 空应答或 `success` 也等价于成功，但显式 `ErrCode = 0` 最稳。
 */
export function buildXpaySuccessReply(): string {
    return '<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>';
}

/** 失败应答：平台据此重试；`errMsg` 里不要放密钥或用户隐私。 */
export function buildXpayFailReply(errMsg: string): string {
    const safe = errMsg.replace(/[<>[\]]/g, ' ').slice(0, 120);

    return `<xml><ErrCode>-1</ErrCode><ErrMsg><![CDATA[${safe}]]></ErrMsg></xml>`;
}

export { VIRTUAL_PAY_EVENTS };
