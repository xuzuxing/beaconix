import { RefundType } from '../../../generated/prisma/enums';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 退款政策配置（来自 `billing.refund.*` 设置项）。
 *
 * 默认值刻意保守：冷静期 7 天、不手续费、无最小额、超过冷静期允许按天折算。
 */
export interface RefundPolicyConfig {
    /** 冷静期天数，从**服务开始日**起算（排队订单落在未生效分支）。 */
    coolingOffDays: number;
    /** 冷静期后是否允许按未使用天数折算；false = 超过冷静期一律不退。 */
    prorate: boolean;
    /** 手续费率（0–0.3），从折算额里扣，单位是比例而不是百分比。 */
    feeRate: number;
    /** 最小退款额（分）；折算结果低于它就直接不退，避免 1 分钱退款单。 */
    minAmount: number;
}

export const DEFAULT_REFUND_POLICY: RefundPolicyConfig = {
    coolingOffDays: 7,
    prorate: true,
    feeRate: 0,
    minAmount: 0,
};

/** 命中哪条政策；写进 `Refund.policyCode`，客服解释「为什么退这么多」时对照。 */
export type RefundPolicyCode =
    | 'NOT_STARTED'
    | 'COOLING_OFF'
    | 'PRORATED'
    | 'EXPIRED'
    | 'NON_REFUNDABLE'
    | 'ALREADY_REFUNDED';

/** 退款对订阅的影响，前端用来渲染「退款后会发生什么」。 */
export type RefundSubscriptionEffect =
    /** 未生效的排队段被作废，当前生效订阅不动 */
    | 'CANCEL_PENDING'
    /** 已生效的订阅立即到期 */
    | 'EXPIRE_NOW'
    /** 续费订单：有效期缩短对应天数 */
    | 'SHRINK'
    /** 已过期/不可退：不动 */
    | 'NONE';

export interface RefundableOrder {
    /** 订单金额（分） */
    amount: number;
    /** 订单天数快照（PlanTerm.durationDays） */
    durationDays: number;
    paidAt: Date | null;
    /** 服务期快照；历史订单为空，用 paidAt 兜底推算 */
    serviceStartsAt: Date | null;
    serviceEndsAt: Date | null;
    /** 已退金额（分） */
    refundedAmount: number;
    /** 订单是否已经产生过订阅段（`subscription.orderId === order.id`） */
    hasOwnSubscription: boolean;
}

export interface RefundQuote {
    /** Historical service allocation cannot be proved; do not submit automatically. */
    requiresManualReview?: boolean;
    eligible: boolean;
    policyCode: RefundPolicyCode;
    /** 可退全额的按 `FULL`，折算按 `PRORATED`；不可退时是「本应走哪条」 */
    type: RefundType;
    usedDays: number;
    remainingDays: number;
    /** 实际可退金额（分）：已扣手续费、已受「累计不超过订单金额」约束 */
    amount: number;
    /** 折算出的原始金额（分），未扣手续费 */
    grossAmount: number;
    /** 手续费（分） */
    feeAmount: number;
    /** 订单金额 - 已退金额 */
    maxRefundable: number;
    subscriptionEffect: RefundSubscriptionEffect;
    /** 不可退时的人类可读原因（直接可展示给用户/运营） */
    reason?: string;
}

/**
 * 退款试算：**纯函数**，不读库、不取当前时间，`now` 由调用方传入。
 *
 * 规则顺序（先命中先返回）：
 * 1. 已全额退过 → ALREADY_REFUNDED
 * 2. 服务期已结束 → EXPIRED
 * 3. 服务未开始（排队/压栈订单）→ NOT_STARTED 全额
 * 4. 服务已开始且已用天数 ≤ 冷静期 → COOLING_OFF 全额
 * 5. 超过冷静期：不折算则 NON_REFUNDABLE；否则 PRORATED 按剩余天数折算
 */
export function quoteRefund(
    order: RefundableOrder,
    now: Date,
    config: RefundPolicyConfig = DEFAULT_REFUND_POLICY,
): RefundQuote {
    const durationDays = Math.max(0, Math.floor(order.durationDays));
    const maxRefundable = Math.max(
        0,
        order.amount - Math.max(0, order.refundedAmount),
    );
    const { startsAt, endsAt } = serviceWindow(order, durationDays);

    const base: Omit<RefundQuote, 'policyCode' | 'type' | 'eligible'> = {
        usedDays: 0,
        remainingDays: durationDays,
        amount: 0,
        grossAmount: 0,
        feeAmount: 0,
        maxRefundable,
        subscriptionEffect: 'NONE',
    };

    if (order.refundedAmount >= order.amount && order.amount > 0) {
        return {
            ...base,
            eligible: false,
            policyCode: 'ALREADY_REFUNDED',
            type: RefundType.FULL,
            reason: 'This order has already been refunded in full.',
        };
    }

    if (durationDays === 0) {
        return {
            ...base,
            eligible: false,
            policyCode: 'NON_REFUNDABLE',
            type: RefundType.FULL,
            reason: 'The order has no billable service period.',
        };
    }

    // 服务未开始：排队/压栈订单，全额退且作废该段。
    if (now.getTime() < startsAt.getTime()) {
        return {
            ...base,
            eligible: maxRefundable > 0,
            policyCode: 'NOT_STARTED',
            type: RefundType.FULL,
            amount: maxRefundable,
            grossAmount: maxRefundable,
            // 排队段（订单自己建的订阅）直接作废；续费订单则回退到原到期时刻。
            subscriptionEffect: order.hasOwnSubscription
                ? 'CANCEL_PENDING'
                : 'SHRINK',
            reason: maxRefundable > 0 ? undefined : 'Nothing left to refund.',
        };
    }

    const usedDays = Math.min(
        durationDays,
        Math.max(1, Math.ceil((now.getTime() - startsAt.getTime()) / DAY_MS)),
    );
    const remainingDays = Math.max(0, durationDays - usedDays);

    if (now.getTime() >= endsAt.getTime() || remainingDays === 0) {
        return {
            ...base,
            usedDays,
            remainingDays: 0,
            eligible: false,
            policyCode: 'EXPIRED',
            type: RefundType.PRORATED,
            reason: 'The service period for this order has already ended.',
        };
    }

    // 冷静期内（含满第 N 天）：全额退，订阅按订单类型收回。
    if (usedDays <= config.coolingOffDays) {
        return {
            ...base,
            usedDays,
            remainingDays,
            eligible: maxRefundable > 0,
            policyCode: 'COOLING_OFF',
            type: RefundType.FULL,
            amount: maxRefundable,
            grossAmount: maxRefundable,
            subscriptionEffect: order.hasOwnSubscription
                ? 'EXPIRE_NOW'
                : 'SHRINK',
            reason: maxRefundable > 0 ? undefined : 'Nothing left to refund.',
        };
    }

    if (!config.prorate) {
        return {
            ...base,
            usedDays,
            remainingDays,
            eligible: false,
            policyCode: 'NON_REFUNDABLE',
            type: RefundType.PRORATED,
            reason: `Refunds are only available within ${config.coolingOffDays} days of the service start.`,
        };
    }

    // 折算：先按剩余天数算总额，再扣手续费——日单价不单独取整，避免误差累积。
    const grossAmount = Math.round(
        (maxRefundable * remainingDays) / durationDays,
    );
    const feeAmount = Math.min(
        grossAmount,
        Math.floor(grossAmount * clampRate(config.feeRate)),
    );
    const amount = Math.max(0, grossAmount - feeAmount);
    const effect: RefundSubscriptionEffect = order.hasOwnSubscription
        ? 'EXPIRE_NOW'
        : 'SHRINK';

    if (amount < config.minAmount || amount <= 0) {
        return {
            ...base,
            usedDays,
            remainingDays,
            grossAmount,
            feeAmount,
            // 金额照样回填：前端要能展示「本可退多少、差在哪」
            amount,
            eligible: false,
            policyCode: amount <= 0 ? 'EXPIRED' : 'PRORATED',
            type: RefundType.PRORATED,
            subscriptionEffect: effect,
            reason:
                amount <= 0
                    ? 'There is no unused service left to refund.'
                    : `The prorated refund (${amount} cents) is below the minimum refund amount (${config.minAmount} cents).`,
        };
    }

    return {
        ...base,
        usedDays,
        remainingDays,
        eligible: true,
        policyCode: 'PRORATED',
        type: RefundType.PRORATED,
        amount,
        grossAmount,
        feeAmount,
        subscriptionEffect: effect,
    };
}

/**
 * 服务期兜底：新订单有结算时写入的快照；历史订单（快照为空）用 `paidAt`
 * 与其后 `durationDays` 推算，保证老订单也能走折算而不是直接不可退。
 */
export function serviceWindow(
    order: Pick<
        RefundableOrder,
        'durationDays' | 'paidAt' | 'serviceStartsAt' | 'serviceEndsAt'
    >,
    durationDays = Math.max(0, Math.floor(order.durationDays)),
): { startsAt: Date; endsAt: Date } {
    const startsAt = order.serviceStartsAt ?? order.paidAt ?? new Date(0);
    const endsAt =
        order.serviceEndsAt ??
        new Date(startsAt.getTime() + durationDays * DAY_MS);

    return { startsAt, endsAt };
}

function clampRate(rate: number): number {
    if (!Number.isFinite(rate) || rate <= 0) return 0;

    return Math.min(rate, 0.3);
}
