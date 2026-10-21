import { RefundType } from '../../../generated/prisma/enums';
import {
    DAY_MS,
    DEFAULT_REFUND_POLICY,
    quoteRefund,
    serviceWindow,
    type RefundPolicyConfig,
    type RefundableOrder,
} from './refund-policy';

const HOUR_MS = 60 * 60 * 1000;
const T0 = new Date('2026-03-01T00:00:00.000Z');

/** T0 + days 天 + hours 小时 */
function at(days: number, hours = 0): Date {
    return new Date(T0.getTime() + days * DAY_MS + hours * HOUR_MS);
}

function makeOrder(overrides: Partial<RefundableOrder> = {}): RefundableOrder {
    return {
        amount: 29900,
        durationDays: 30,
        paidAt: T0,
        serviceStartsAt: T0,
        serviceEndsAt: at(30),
        refundedAmount: 0,
        hasOwnSubscription: true,
        ...overrides,
    };
}

function policy(
    overrides: Partial<RefundPolicyConfig> = {},
): RefundPolicyConfig {
    return { ...DEFAULT_REFUND_POLICY, ...overrides };
}

describe('quoteRefund', () => {
    describe('R1 服务未开始', () => {
        it('refunds in full and cancels the queued segment', () => {
            const quote = quoteRefund(makeOrder(), at(-1));

            expect(quote).toMatchObject({
                eligible: true,
                policyCode: 'NOT_STARTED',
                type: RefundType.FULL,
                usedDays: 0,
                remainingDays: 30,
                amount: 29900,
                subscriptionEffect: 'CANCEL_PENDING',
            });
        });

        it('shrinks the renewal instead when the order has no segment of its own', () => {
            const quote = quoteRefund(
                makeOrder({ hasOwnSubscription: false }),
                at(-1),
            );

            expect(quote).toMatchObject({
                policyCode: 'NOT_STARTED',
                subscriptionEffect: 'SHRINK',
            });
        });
    });

    describe('R2 冷静期', () => {
        it('refunds in full while the used days are within the cooling-off window', () => {
            const quote = quoteRefund(makeOrder(), at(3));

            expect(quote).toMatchObject({
                eligible: true,
                policyCode: 'COOLING_OFF',
                type: RefundType.FULL,
                usedDays: 3,
                remainingDays: 27,
                amount: 29900,
                subscriptionEffect: 'EXPIRE_NOW',
            });
        });

        it('includes the last day of the window', () => {
            const quote = quoteRefund(makeOrder(), at(7));

            expect(quote).toMatchObject({
                policyCode: 'COOLING_OFF',
                usedDays: 7,
            });
        });

        it('leaves the window one hour later', () => {
            const quote = quoteRefund(makeOrder(), at(7, 1));

            expect(quote.policyCode).toBe('PRORATED');
            expect(quote.usedDays).toBe(8);
        });

        it('shrinks a renewal instead of expiring it', () => {
            const quote = quoteRefund(
                makeOrder({ hasOwnSubscription: false }),
                at(3),
            );

            expect(quote.subscriptionEffect).toBe('SHRINK');
        });
    });

    describe('R3 按天折算', () => {
        it('prorates by unused days with integer cents', () => {
            const quote = quoteRefund(makeOrder(), at(10));

            // round(29900 * 20 / 30) = 19933
            expect(quote).toMatchObject({
                eligible: true,
                policyCode: 'PRORATED',
                type: RefundType.PRORATED,
                usedDays: 10,
                remainingDays: 20,
                grossAmount: 19933,
                feeAmount: 0,
                amount: 19933,
                subscriptionEffect: 'EXPIRE_NOW',
            });
        });

        it('shrinks the subscription for a renewal order', () => {
            const quote = quoteRefund(
                makeOrder({ hasOwnSubscription: false }),
                at(10),
            );

            expect(quote.subscriptionEffect).toBe('SHRINK');
        });

        it('counts a partial day as one whole day', () => {
            expect(quoteRefund(makeOrder(), at(0, 1)).usedDays).toBe(1);
            expect(quoteRefund(makeOrder(), at(0, 23)).usedDays).toBe(1);
            // 整 24 小时才算第 1 天结束，第 2 天才开始
            expect(quoteRefund(makeOrder(), at(1)).usedDays).toBe(1);
            expect(quoteRefund(makeOrder(), at(1, 1)).usedDays).toBe(2);
            expect(quoteRefund(makeOrder(), at(2)).usedDays).toBe(2);
        });

        it('rounds the prorated amount to the nearest cent', () => {
            // round(29900 * 1 / 30) = 997（996.67）
            const quote = quoteRefund(makeOrder(), at(29));

            expect(quote).toMatchObject({
                usedDays: 29,
                remainingDays: 1,
                grossAmount: 997,
                amount: 997,
            });
        });

        it('deducts the configured fee rate', () => {
            const quote = quoteRefund(
                makeOrder(),
                at(10),
                policy({ feeRate: 0.05 }),
            );

            // floor(19933 * 0.05) = 996
            expect(quote).toMatchObject({
                grossAmount: 19933,
                feeAmount: 996,
                amount: 18937,
            });
        });

        it('caps the fee rate at 30%', () => {
            const quote = quoteRefund(
                makeOrder(),
                at(10),
                policy({ feeRate: 0.9 }),
            );

            // floor(19933 * 0.3) = 5979
            expect(quote.feeAmount).toBe(5979);
            expect(quote.amount).toBe(13954);
        });

        it('refuses amounts under the configured minimum', () => {
            const quote = quoteRefund(
                makeOrder(),
                at(10),
                policy({ minAmount: 20000 }),
            );

            expect(quote).toMatchObject({
                eligible: false,
                policyCode: 'PRORATED',
                amount: 19933,
            });
            expect(quote.reason).toContain('minimum refund amount');
        });
    });

    describe('R4 已过期', () => {
        it('refuses once the service period is over', () => {
            const quote = quoteRefund(makeOrder(), at(30));

            expect(quote).toMatchObject({
                eligible: false,
                policyCode: 'EXPIRED',
                usedDays: 30,
                remainingDays: 0,
                amount: 0,
                subscriptionEffect: 'NONE',
            });
        });

        it('refuses well after the service period', () => {
            const quote = quoteRefund(makeOrder(), at(120));

            expect(quote.policyCode).toBe('EXPIRED');
            expect(quote.eligible).toBe(false);
        });

        it('treats a zero-day order as non-refundable', () => {
            const quote = quoteRefund(makeOrder({ durationDays: 0 }), at(0));

            expect(quote).toMatchObject({
                eligible: false,
                policyCode: 'NON_REFUNDABLE',
            });
        });
    });

    describe('不折算的配置', () => {
        it('refuses everything after the cooling-off window', () => {
            const quote = quoteRefund(
                makeOrder(),
                at(10),
                policy({ prorate: false }),
            );

            expect(quote).toMatchObject({
                eligible: false,
                policyCode: 'NON_REFUNDABLE',
            });
            expect(quote.reason).toContain('within 7 days');
        });
    });

    describe('累计退款上限', () => {
        it('refuses an order that is already fully refunded', () => {
            const quote = quoteRefund(
                makeOrder({ refundedAmount: 29900 }),
                at(3),
            );

            expect(quote).toMatchObject({
                eligible: false,
                policyCode: 'ALREADY_REFUNDED',
                amount: 0,
                maxRefundable: 0,
            });
        });

        it('prorates against what is still refundable', () => {
            const quote = quoteRefund(
                makeOrder({ refundedAmount: 10000 }),
                at(10),
            );

            // maxRefundable = 19900 → round(19900 * 20 / 30) = 13267
            expect(quote).toMatchObject({
                maxRefundable: 19900,
                grossAmount: 13267,
                amount: 13267,
            });
        });
    });

    describe('服务期快照', () => {
        it('falls back to paidAt for orders without a snapshot', () => {
            const legacy = makeOrder({
                serviceStartsAt: null,
                serviceEndsAt: null,
            });

            const withSnapshot = quoteRefund(makeOrder(), at(10));
            const legacyQuote = quoteRefund(legacy, at(10));

            expect(legacyQuote.policyCode).toBe(withSnapshot.policyCode);
            expect(legacyQuote.usedDays).toBe(withSnapshot.usedDays);
            expect(legacyQuote.amount).toBe(withSnapshot.amount);
        });
    });
});

describe('serviceWindow', () => {
    it('prefers the stored snapshot', () => {
        const startsAt = at(-2);
        const endsAt = at(28);

        expect(
            serviceWindow({
                durationDays: 30,
                paidAt: T0,
                serviceStartsAt: startsAt,
                serviceEndsAt: endsAt,
            }),
        ).toEqual({ startsAt, endsAt });
    });

    it('derives the window from paidAt and durationDays', () => {
        const window = serviceWindow({
            durationDays: 30,
            paidAt: T0,
            serviceStartsAt: null,
            serviceEndsAt: null,
        });

        expect(window.startsAt).toEqual(T0);
        expect(window.endsAt).toEqual(at(30));
    });
});

describe('DEFAULT_REFUND_POLICY', () => {
    it('ships a 7-day cooling-off window without fees', () => {
        expect(DEFAULT_REFUND_POLICY).toEqual({
            coolingOffDays: 7,
            prorate: true,
            feeRate: 0,
            minAmount: 0,
        });
    });
});
