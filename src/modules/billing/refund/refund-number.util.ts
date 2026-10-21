import { randomBytes } from 'node:crypto';

/**
 * 退款单号：字母数字、可读，微信（`out_refund_no`）与支付宝
 * （`out_request_no`）都要求 6–64 位，这里固定 18 位。
 *
 * 同时被主动退款（`RefundService`）与被动退款（虚拟支付退款推送补记录）使用。
 */
export function generateRefundNo(): string {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(4).toString('hex');

    return `RF${timestamp}${random}`.toUpperCase();
}
