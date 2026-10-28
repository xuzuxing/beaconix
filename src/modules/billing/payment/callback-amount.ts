import { PaymentChannel } from '../../../generated/prisma/enums';
import type { PaymentProviderCallbackResult } from './payment-provider.interface';

/**
 * Alipay sends yuan as a two-decimal string (`"19.99"`), the platform stores
 * fen. Anything that is not a clean non-negative amount yields `null` so the
 * caller can reject the callback instead of guessing.
 */
export function fenFromYuan(value: unknown): number | null {
    if (typeof value !== 'string' && typeof value !== 'number') return null;

    const amount = Number(value);

    if (!Number.isFinite(amount) || amount < 0) return null;

    return Math.round(amount * 100);
}

/**
 * The amount the channel says was actually paid, in fen.
 *
 * `null` means "cannot verify" (field missing or malformed) and must be treated
 * as a rejection: a signature-verified callback always carries the amount, so a
 * missing one means the payload is not what we think it is. The
 * `WECHAT_VIRTUAL` channel never reaches this path — it verifies amounts in
 * `WechatVirtualPaymentService` against its own `PaymentAttempt`.
 */
export function resolvePaidAmountFen(
    channel: PaymentChannel,
    callback: PaymentProviderCallbackResult,
): number | null {
    if (channel === PaymentChannel.WECHAT) {
        // WeChat Pay V3 nests it as `amount.total`, already in fen.
        const total = (callback.amount as { total?: unknown } | undefined)
            ?.total;

        if (
            typeof total !== 'number' ||
            !Number.isInteger(total) ||
            total < 0
        ) {
            return null;
        }

        return total;
    }

    if (channel === PaymentChannel.ALIPAY) {
        return fenFromYuan(callback.total_amount);
    }

    return null;
}
