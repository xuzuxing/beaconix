import { createHmac } from 'node:crypto';
import type {
    VirtualPaySignDataInput,
    WechatVirtualPayEnv,
} from './wechat-virtual-pay.types';

/**
 * 虚拟支付的两套 HMAC-SHA256 签名。
 *
 * 文档（2.5 签名详解）：
 * - 支付签名 `paySig = to_hex(hmac_sha256(appKey, uri + '&' + signData))`
 * - 用户态签名 `signature = to_hex(hmac_sha256(sessionKey, signData))`
 *
 * 关键点：`signData` 必须是**实际发出去的那个字符串**。C 端签名时它是
 * `wx.requestVirtualPayment` 的 `signData` 字段；服务端接口签名时它是 POST
 * body 原文。任何重新序列化（键顺序变化、多/少空格）都会让签名失效。
 */

/** C 端下单签名时的固定 `uri`。 */
export const VIRTUAL_PAY_REQUEST_URI = 'requestVirtualPayment';

/** 币种固定为人民币。 */
const CURRENCY_TYPE = 'CNY';

function hmacSha256Hex(key: string, message: string): string {
    return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

/** `paySig`，密钥是 MP 后台的 AppKey（现网 / 沙箱按 env 区分）。 */
export function calcVirtualPaySig(
    appKey: string,
    uri: string,
    body: string,
): string {
    return hmacSha256Hex(appKey, `${uri}&${body}`);
}

/** 用户态签名，密钥是 `auth.code2Session` 拿到的 sessionKey。 */
export function calcVirtualPayUserSignature(
    sessionKey: string,
    signData: string,
): string {
    return hmacSha256Hex(sessionKey, signData);
}

/**
 * 按**固定顺序**拼出 `signData` 字符串。
 *
 * 文档示例的顺序是 `offerId, buyQuantity, env, currencyType, productId,
 * goodsPrice, outTradeNo, attach`，这里逐字段写入而不是整体
 * `JSON.stringify(object)`，以免对象键顺序被后续重构悄悄改变；每个值仍走
 * `JSON.stringify` 做转义，保证 `attach` 里的引号/反斜杠不会破坏 JSON。
 */
export function buildVirtualPaySignData(
    input: VirtualPaySignDataInput,
): string {
    const fields = [
        `"offerId":${JSON.stringify(input.offerId)}`,
        `"buyQuantity":${input.buyQuantity}`,
        `"env":${input.env}`,
        `"currencyType":${JSON.stringify(CURRENCY_TYPE)}`,
        `"productId":${JSON.stringify(input.productId)}`,
        `"goodsPrice":${input.goodsPrice}`,
        `"outTradeNo":${JSON.stringify(input.outTradeNo)}`,
        `"attach":${JSON.stringify(input.attach)}`,
    ];

    return `{${fields.join(',')}}`;
}

/** 环境标识归一：只有 1 才是沙箱，其余一律现网（0）。 */
export function normalizeVirtualPayEnv(value: number): WechatVirtualPayEnv {
    return value === 1 ? 1 : 0;
}
