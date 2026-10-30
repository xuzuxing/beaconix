import { billingPaymentFixture } from '../../../../test/fixtures/billing-payment.fixture';

describe('Refund amounts and winning payment identity', () => {
    async function setup() {
        const f = billingPaymentFixture();
        const order = await f.newOrder();
        const pay = await f.payments.createPayment(order.id, 'buyer', {
            openid: 'o',
        });
        await f.payments.handleWechatCallback(
            JSON.stringify(f.paid(pay.outTradeNo)),
            'verified',
        );
        const refund = await f.refunds.create({ orderId: order.id });
        const callback = {
            outRefundNo: refund.refundNo,
            status: 'SUCCESS',
            refundFee: 2900,
            totalFee: 2900,
            currency: 'CNY',
            outTradeNo: pay.outTradeNo,
            transactionId: `tx-${pay.outTradeNo}`,
        };
        return { ...f, refund, callback };
    }

    it.each([
        { refundFee: undefined },
        { refundFee: 1 },
        { refundFee: 2900.5 },
        { totalFee: undefined },
        { totalFee: 1 },
        { currency: 'USD' },
        { outTradeNo: 'OTHER' },
        { transactionId: 'OTHER' },
    ])(
        'does not settle an inconsistent refund callback: %s',
        async (overrides) => {
            const f = await setup();
            const result = await f.refunds.handleWechatRefundCallback(
                JSON.stringify({ ...f.callback, ...overrides }),
                'verified',
            );
            expect(result.handled).toBe(false);
            expect(f.rows('refund')[0].status).toBe('PROCESSING');
            expect(f.rows('order')[0].status).toBe('PAID');
            expect(f.rows('subscription')[0].status).toBe('ACTIVE');
        },
    );

    it('rejects a WeChat refund notification for an Alipay refund', async () => {
        const f = await setup();
        f.rows('refund')[0].channel = 'ALIPAY';
        expect(
            (
                await f.refunds.handleWechatRefundCallback(
                    JSON.stringify(f.callback),
                    'verified',
                )
            ).handled,
        ).toBe(false);
        expect(f.rows('order')[0].status).toBe('PAID');
    });

    it('applies a valid callback once and sends refund/query requests to the winning merchant number', async () => {
        const f = await setup();
        expect(f.provider.refund).toHaveBeenCalledWith(
            expect.objectContaining({ outTradeNo: f.callback.outTradeNo }),
        );
        for (let repeat = 0; repeat < 2; repeat++) {
            expect(
                (
                    await f.refunds.handleWechatRefundCallback(
                        JSON.stringify(f.callback),
                        'verified',
                    )
                ).handled,
            ).toBe(true);
        }
        expect(f.rows('order')[0]).toMatchObject({
            status: 'REFUNDED',
            refundedAmount: 2900,
        });
        expect(f.rows('payment')[0].refundedAmount).toBe(2900);
        expect(
            f.notifications.publish.mock.calls.filter(([e]) =>
                e.eventKey.startsWith('payment-refunded:'),
            ),
        ).toHaveLength(1);
    });
});
