import { billingPaymentFixture } from '../../../../test/fixtures/billing-payment.fixture';

describe('Payment attempts and reconciliation (transactional fixture)', () => {
    async function checkout(channel: 'WECHAT' | 'ALIPAY' = 'WECHAT') {
        const f = billingPaymentFixture();
        const order = await f.newOrder();
        const pay = await f.payments.createPayment(order.id, 'buyer', {
            channel,
            openid: 'openid',
        });
        return { ...f, order, pay };
    }

    it('persists a separate merchant number before each channel request', async () => {
        const f = await checkout();
        f.provider.createPayment.mockImplementation(({ outTradeNo }) =>
            Promise.resolve().then(() => {
                expect(
                    f
                        .rows('paymentAttempt')
                        .find((a) => a.outTradeNo === outTradeNo),
                ).toBeDefined();
                return { payUrl: 'cashier' };
            }),
        );
        const second = await f.payments.createPayment(f.order.id, 'buyer', {
            channel: 'ALIPAY',
        });
        expect(second.outTradeNo).not.toBe(f.pay.outTradeNo);
        expect(f.rows('paymentAttempt')).toHaveLength(2);
        expect(f.rows('payment')).toHaveLength(1);
    });

    it('keeps a timed-out creation queryable and settles a lost callback', async () => {
        const f = billingPaymentFixture();
        const order = await f.newOrder();
        f.provider.createPayment.mockRejectedValue(
            new Error('timeout after channel accepted'),
        );
        await expect(
            f.payments.createPayment(order.id, 'buyer', { openid: 'o' }),
        ).rejects.toThrow('timeout');
        expect(f.rows('paymentAttempt')[0].status).toBe('FAILED');
        f.provider.queryPayment.mockImplementation((no) =>
            Promise.resolve().then(() => f.paid(no)),
        );
        expect(await f.payments.reconcilePendingAttempts()).toEqual({
            checked: 1,
            settled: 1,
        });
        expect(f.rows('order')[0].status).toBe('PAID');
        expect(f.rows('subscription')).toHaveLength(1);
    });

    it('allows the callback to settle before the create response arrives', async () => {
        const f = billingPaymentFixture();
        const order = await f.newOrder();
        f.provider.createPayment.mockImplementation(async ({ outTradeNo }) => {
            await f.payments.handleWechatCallback(
                JSON.stringify(f.paid(outTradeNo)),
                'verified',
            );
            return { package: 'prepay_id=early' };
        });
        const result = await f.payments.createPayment(order.id, 'buyer', {
            openid: 'o',
        });
        expect(result.package).toBe('prepay_id=early');
        expect(f.rows('payment')[0].status).toBe('SUCCESS');
        expect(f.rows('subscription')).toHaveLength(1);
    });

    it('closes a checkout if the order was cancelled during channel creation', async () => {
        const f = billingPaymentFixture();
        const order = await f.newOrder();
        f.provider.createPayment.mockImplementation(async () => {
            await f.payments.cancelOrder(order.id);
            return { package: 'late' };
        });
        await expect(
            f.payments.createPayment(order.id, 'buyer', { openid: 'o' }),
        ).rejects.toThrow('no longer payable');
        expect(f.rows('order')[0].status).toBe('CANCELLED');
        expect(f.rows('subscription')).toHaveLength(0);
        expect(f.provider.closePayment).toHaveBeenCalled();
    });

    it('serializes callback and query into one subscription and preserves the winner', async () => {
        const f = await checkout();
        f.provider.queryPayment.mockImplementation((no) =>
            Promise.resolve().then(() => f.paid(no)),
        );
        await Promise.all([
            f.payments.handleWechatCallback(
                JSON.stringify(f.paid(f.pay.outTradeNo)),
                'verified',
            ),
            f.payments.reconcilePendingAttempts(),
        ]);
        expect(f.rows('subscription')).toHaveLength(1);
        expect(f.rows('payment')[0].outTradeNo).toBe(f.pay.outTradeNo);
        expect(
            f.notifications.publish.mock.calls.filter(([e]) =>
                e.eventKey.startsWith('payment-succeeded:'),
            ),
        ).toHaveLength(1);
    });

    it('records a second channel payment without replacing the first settlement', async () => {
        const f = await checkout();
        const second = await f.payments.createPayment(f.order.id, 'buyer', {
            channel: 'ALIPAY',
        });
        await f.payments.handleWechatCallback(
            JSON.stringify(f.paid(f.pay.outTradeNo)),
            'verified',
        );
        const callback = JSON.stringify(
            f.paid(second.outTradeNo, { total_amount: '29.00' }),
        );
        await f.payments.handleAlipayCallback(callback);
        await f.payments.handleAlipayCallback(callback);
        expect(f.rows('subscription')).toHaveLength(1);
        expect(f.rows('payment')[0]).toMatchObject({
            channel: 'WECHAT',
            outTradeNo: f.pay.outTradeNo,
        });
        expect(f.rows('paymentAttempt').map((a) => a.status)).toEqual([
            'PAID',
            'PAID',
        ]);
        expect(
            f.notifications.publish.mock.calls.filter(([e]) =>
                e.eventKey.startsWith('payment-duplicate:'),
            ),
        ).toHaveLength(1);
    });

    it.each(['CANCELLED', 'REFUNDED'])(
        'records late funds without reopening a %s order',
        async (status) => {
            const f = await checkout();
            f.rows('order')[0].status = status;
            await f.payments.handleWechatCallback(
                JSON.stringify(f.paid(f.pay.outTradeNo)),
                'verified',
            );
            expect(f.rows('order')[0].status).toBe(status);
            expect(f.rows('paymentAttempt')[0]).toMatchObject({
                status: 'PAID',
                lastError: expect.stringContaining('manual refund'),
            });
            expect(f.rows('subscription')).toHaveLength(0);
            expect(f.notifications.publish).toHaveBeenCalledWith(
                expect.objectContaining({ email: true }),
                expect.anything(),
            );
        },
    );

    it('rejects wrong amounts and cross-channel merchant numbers', async () => {
        const f = await checkout();
        const wrong = await f.payments.handleWechatCallback(
            JSON.stringify(f.paid(f.pay.outTradeNo, { amount: { total: 1 } })),
            'verified',
        );
        expect(wrong.code).toBe('FAIL');
        expect(
            (
                await f.payments.handleAlipayCallback(
                    JSON.stringify(f.paid(f.pay.outTradeNo)),
                )
            ).code,
        ).toBe('FAIL');
        expect(f.rows('subscription')).toHaveLength(0);
    });

    it('rolls back payment, subscription and attempt together on settlement failure', async () => {
        const f = await checkout();
        f.plans.getEffectivePlanInTransaction.mockRejectedValue(
            new Error('snapshot failed'),
        );
        await expect(
            f.payments.handleWechatCallback(
                JSON.stringify(f.paid(f.pay.outTradeNo)),
                'verified',
            ),
        ).rejects.toThrow('snapshot failed');
        expect(f.rows('payment')[0].status).toBe('PENDING');
        expect(f.rows('paymentAttempt')[0].status).toBe('PENDING');
        expect(f.rows('subscription')).toHaveLength(0);
    });

    it('queries before cancellation and preserves a paid order when the callback was lost', async () => {
        const f = await checkout();
        f.provider.queryPayment.mockImplementation((no) =>
            Promise.resolve().then(() => f.paid(no)),
        );
        expect(await f.payments.cancelOrder(f.order.id)).toBe(false);
        expect(f.rows('order')[0].status).toBe('PAID');
        expect(f.provider.closePayment).not.toHaveBeenCalled();
    });

    it('rechecks funds when payment wins the query-to-close race', async () => {
        const f = await checkout();
        f.provider.closePayment.mockRejectedValue(new Error('already paid'));
        f.provider.queryPayment
            .mockResolvedValueOnce({
                out_trade_no: f.pay.outTradeNo,
                transaction_id: '',
                trade_state: 'NOTPAY',
            })
            .mockResolvedValueOnce(f.paid(f.pay.outTradeNo));
        expect(await f.payments.cancelOrder(f.order.id)).toBe(false);
        expect(f.rows('subscription')).toHaveLength(1);
    });

    it('cancels locally on failed close and retries it on the next sweep', async () => {
        const f = await checkout('ALIPAY');
        f.provider.closePayment.mockRejectedValueOnce(
            new Error('ACQ.TRADE_NOT_EXIST'),
        );
        expect(await f.payments.cancelOrder(f.order.id)).toBe(true);
        expect(f.rows('paymentAttempt')[0]).toMatchObject({
            closePending: true,
            status: 'PENDING',
            lastError: 'ACQ.TRADE_NOT_EXIST',
        });
        await f.payments.reconcilePendingAttempts();
        expect(f.rows('paymentAttempt')[0]).toMatchObject({
            closePending: false,
            status: 'CLOSED',
        });
    });

    it('leaves transient queries pending and records the failure for retry', async () => {
        const f = await checkout();
        f.provider.queryPayment.mockRejectedValue(new Error('network down'));
        expect(await f.payments.reconcilePendingAttempts()).toEqual({
            checked: 1,
            settled: 0,
        });
        expect(f.rows('paymentAttempt')[0]).toMatchObject({
            status: 'PENDING',
            lastError: 'network down',
            reconcileLeaseToken: null,
        });
    });

    it('does not let another worker query an attempt while its lease is active', async () => {
        const f = await checkout();
        const attempt = f.rows('paymentAttempt')[0];
        attempt.reconcileLeaseToken = 'other-worker';
        attempt.reconcileLeaseUntil = new Date(Date.now() + 60000);
        expect(await f.payments.reconcilePendingAttempts()).toEqual({
            checked: 0,
            settled: 0,
        });
        expect(f.provider.queryPayment).not.toHaveBeenCalled();
    });

    it.each(['expired', 'replaced'])(
        'discards a query whose lease was %s without clearing another lease',
        async (kind) => {
            const f = await checkout();
            f.provider.queryPayment.mockImplementation((no) =>
                Promise.resolve().then(() => {
                    const attempt = f.rows('paymentAttempt')[0];
                    if (kind === 'replaced')
                        attempt.reconcileLeaseToken = 'replacement';
                    else attempt.reconcileLeaseUntil = new Date(Date.now() - 1);
                    return f.paid(no);
                }),
            );
            expect(await f.payments.reconcilePendingAttempts()).toEqual({
                checked: 1,
                settled: 0,
            });
            expect(f.rows('order')[0].status).toBe('PENDING');
            if (kind === 'replaced')
                expect(f.rows('paymentAttempt')[0].reconcileLeaseToken).toBe(
                    'replacement',
                );
            expect(f.rows('paymentAttempt')[0].lastCheckedAt).toBeNull();
        },
    );
});
