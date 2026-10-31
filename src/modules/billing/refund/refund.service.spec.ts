import { billingPaymentFixture } from '../../../../test/fixtures/billing-payment.fixture';
import { RefundType } from '../../../generated/prisma/enums';

const DAY = 86_400_000;
const NOW = +new Date('2026-10-31T00:00:00Z');

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
    return { ...f, order: f.rows('order')[0] };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function configure(f: Fixture, overrides: Record<string, unknown>) {
    f.config.config.mockResolvedValue({
        ...(await f.config.config()),
        ...overrides,
    });
}
async function pending(f: Fixture) {
    await configure(f, { autoApproveLimit: 0 });
    return f.refunds.create({
        orderId: f.order.id,
        origin: 'USER',
        actorUserId: 'buyer',
    });
}

describe('RefundService transactional lifecycle', () => {
    beforeEach(() => jest.useFakeTimers({ now: NOW }));
    afterEach(() => jest.useRealTimers());

    it('quotes current usage and enforces membership', async () => {
        const f = await setup();
        jest.setSystemTime(NOW + 10 * DAY);
        const { quote } = await f.refunds.quote(
            f.order.id,
            new Date(),
            'buyer',
        );
        expect(quote).toMatchObject({
            amount: 1933,
            usedDays: 10,
            remainingDays: 20,
            policyCode: 'PRORATED',
        });
        await expect(
            f.refunds.quote(f.order.id, new Date(), 'outsider'),
        ).rejects.toThrow();
        await expect(f.refunds.quote('missing')).rejects.toThrow(
            'Order not found',
        );
    });

    it('persists submission authorization before channel I/O', async () => {
        const f = await setup();
        f.provider.refund.mockImplementation(() => {
            expect(f.rows('refund')[0]).toMatchObject({
                status: 'PROCESSING',
                submittedAt: new Date(NOW),
            });
            return Promise.resolve({ status: 'PROCESSING' });
        });
        const refund = await f.refunds.create({ orderId: f.order.id });
        expect(refund.status).toBe('PROCESSING');
        expect(f.provider.refund).toHaveBeenCalledTimes(1);
    });

    it('keeps manual approval separate from reconciliation and settlement', async () => {
        const f = await setup();
        const refund = await pending(f);
        expect(refund).toMatchObject({ status: 'PENDING', submittedAt: null });
        await f.refunds.syncFromChannel(refund.id);
        await expect(f.refunds.markSuccess(refund.id)).rejects.toThrow(
            'not been authorized',
        );
        expect(f.provider.refund).not.toHaveBeenCalled();
        expect(f.provider.queryRefund).not.toHaveBeenCalled();
        const approved = await f.refunds.approve(refund.id, 'admin');
        expect(approved).toMatchObject({
            status: 'PROCESSING',
            approvedBy: 'admin',
        });
    });

    it('admits one of concurrent create requests', async () => {
        const f = await setup();
        const results = await Promise.allSettled(
            Array.from({ length: 8 }, () =>
                f.refunds.create({ orderId: f.order.id }),
            ),
        );
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(f.rows('refund')).toHaveLength(1);
        expect(f.provider.refund).toHaveBeenCalledTimes(1);
    });

    it('serializes approval against approval and withdrawal', async () => {
        const f = await setup();
        const refund = await pending(f);
        const results = await Promise.allSettled([
            f.refunds.approve(refund.id),
            f.refunds.approve(refund.id),
            f.refunds.markClosed(refund.id),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(f.provider.refund).toHaveBeenCalledTimes(1);
    });

    it('closes only unsubmitted requests and permits a new request after withdrawal', async () => {
        const f = await setup();
        const refund = await pending(f);
        await f.refunds.markClosed(refund.id, 'withdrawn');
        await f.refunds.markClosed(refund.id);
        await expect(f.refunds.approve(refund.id)).rejects.toThrow();
        const next = await f.refunds.create({ orderId: f.order.id });
        await expect(f.refunds.markClosed(next.id)).rejects.toThrow(
            'unsubmitted',
        );
    });

    it('retains an uncertain channel result and settles it through query', async () => {
        const f = await setup();
        f.provider.refund.mockRejectedValueOnce(new Error('response lost'));
        const refund = await f.refunds.create({ orderId: f.order.id });
        expect(refund).toMatchObject({
            status: 'PROCESSING',
            failureReason: 'response lost',
        });
        await expect(
            f.refunds.create({ orderId: f.order.id }),
        ).rejects.toThrow();
        await expect(f.refunds.markClosed(refund.id)).rejects.toThrow();
        const settled = await f.refunds.syncFromChannel(refund.id);
        expect(settled.status).toBe('SUCCESS');
        expect(f.provider.refund).toHaveBeenCalledTimes(1);
        expect(f.rows('order')[0].refundedAmount).toBe(2900);
    });

    it('retries explicit failures with the same merchant refund key and amount', async () => {
        const f = await setup();
        f.provider.refund.mockResolvedValueOnce({
            status: 'FAILED',
            failureReason: 'rejected',
        });
        const refund = await f.refunds.create({ orderId: f.order.id });
        expect(refund.status).toBe('FAILED');
        await f.refunds.retry(refund.id);
        expect(f.provider.refund.mock.calls[1][0]).toMatchObject({
            outRefundNo: refund.refundNo,
            refundFee: refund.amount,
        });
        await expect(f.refunds.retry(refund.id)).rejects.toThrow(
            'Only a failed',
        );
    });

    it('blocks a failed request retry when another request has claimed the order', async () => {
        const f = await setup();
        f.provider.refund.mockResolvedValueOnce({ status: 'FAILED' });
        const first = await f.refunds.create({ orderId: f.order.id });
        await f.refunds.create({ orderId: f.order.id });
        await expect(f.refunds.retry(first.id)).rejects.toThrow();
        expect(f.provider.refund).toHaveBeenCalledTimes(2);
    });

    it('replays a durable submission only on definite absence', async () => {
        const f = await setup();
        const refund = await f.refunds.create({ orderId: f.order.id });
        f.provider.queryRefund.mockResolvedValueOnce({
            status: 'PROCESSING',
            notFound: true,
        } as any);
        f.provider.refund.mockResolvedValueOnce({ status: 'SUCCESS' });
        expect((await f.refunds.syncFromChannel(refund.id)).status).toBe(
            'SUCCESS',
        );
        expect(f.provider.refund.mock.calls[1][0]).toMatchObject({
            outRefundNo: refund.refundNo,
            refundFee: refund.amount,
        });
        await f.refunds.syncFromChannel(refund.id);
        expect(f.provider.refund).toHaveBeenCalledTimes(2);
        expect(f.rows('payment')[0].refundedAmount).toBe(2900);
    });

    it('does not replay on query outage and advances the scan timestamp', async () => {
        const f = await setup();
        const refund = await f.refunds.create({ orderId: f.order.id });
        jest.setSystemTime(NOW + DAY);
        f.provider.queryRefund.mockRejectedValueOnce(
            new Error('query offline'),
        );
        await expect(f.refunds.syncFromChannel(refund.id)).rejects.toThrow(
            'query offline',
        );
        expect(f.provider.refund).toHaveBeenCalledTimes(1);
        expect(f.rows('refund')[0]).toMatchObject({
            status: 'PROCESSING',
            updatedAt: new Date(NOW + DAY),
        });
    });

    it('settles once and ignores late failure/processing callbacks', async () => {
        const f = await setup();
        const refund = await f.refunds.create({ orderId: f.order.id });
        await Promise.all([
            f.refunds.markSuccess(refund.id),
            f.refunds.markSuccess(refund.id),
        ]);
        await f.refunds.markFailed(refund.id, 'late failure');
        await f.refunds.markProcessing(refund.id, { status: 'PROCESSING' });
        expect(f.rows('refund')[0].status).toBe('SUCCESS');
        expect(f.rows('order')[0].refundedAmount).toBe(2900);
        expect(
            f.notifications.publish.mock.calls.filter(
                ([event]) => event.eventKey === `payment-refunded:${refund.id}`,
            ),
        ).toHaveLength(1);
    });

    it('rolls back settlement failure while keeping durable submission for reconciliation', async () => {
        const f = await setup();
        f.provider.refund.mockResolvedValueOnce({ status: 'SUCCESS' });
        f.notifications.publish.mockRejectedValueOnce(
            new Error('outbox unavailable'),
        );
        await expect(f.refunds.create({ orderId: f.order.id })).rejects.toThrow(
            'outbox unavailable',
        );
        expect(f.rows('refund')[0].status).toBe('PROCESSING');
        expect(f.rows('order')[0].refundedAmount).toBe(0);
        await f.refunds.syncFromChannel(f.rows('refund')[0].id);
        expect(f.rows('order')[0].refundedAmount).toBe(2900);
    });

    it('validates settlement amounts against the request and both financial balances', async () => {
        const f = await setup();
        const refund = await f.refunds.create({ orderId: f.order.id });
        await expect(
            f.refunds.markSuccess(refund.id, {
                status: 'SUCCESS',
                refundFee: 1,
            }),
        ).rejects.toThrow('amount mismatch');
        f.rows('payment')[0].refundedAmount = 1;
        await expect(f.refunds.markSuccess(refund.id)).rejects.toThrow(
            'remaining paid amount',
        );
        expect(f.rows('order')[0].refundedAmount).toBe(0);
    });

    it.each([0, -1, 1.5, 2901])(
        'rejects invalid manual amount %s without channel I/O',
        async (amount) => {
            const f = await setup();
            await expect(
                f.refunds.create({
                    orderId: f.order.id,
                    type: RefundType.MANUAL,
                    amount,
                }),
            ).rejects.toThrow();
            expect(f.provider.refund).not.toHaveBeenCalled();
            expect(f.rows('refund')).toHaveLength(0);
        },
    );

    it('supports a bounded manual refund and uses the payment channel provider', async () => {
        const f = await setup();
        f.rows('payment')[0].channel = 'WECHAT_VIRTUAL';
        const result = await f.refunds.create({
            orderId: f.order.id,
            type: RefundType.MANUAL,
            amount: 500,
        });
        expect(result).toMatchObject({ amount: 500, policyCode: 'MANUAL' });
        expect(f.providers.getRefundProvider).toHaveBeenCalledWith(
            'WECHAT_VIRTUAL',
        );
    });

    it('enforces feature switches and actor membership', async () => {
        const f = await setup();
        await configure(f, { enabled: false });
        await expect(f.refunds.create({ orderId: f.order.id })).rejects.toThrow(
            'disabled',
        );
        await configure(f, { enabled: true, userSelfService: false });
        await expect(
            f.refunds.create({
                orderId: f.order.id,
                origin: 'USER',
                actorUserId: 'buyer',
            }),
        ).rejects.toThrow('disabled');
        await configure(f, { userSelfService: true });
        await expect(
            f.refunds.create({ orderId: f.order.id, origin: 'USER' }),
        ).rejects.toThrow('actor');
        await expect(
            f.refunds.create({
                orderId: f.order.id,
                origin: 'USER',
                actorUserId: 'outsider',
            }),
        ).rejects.toThrow();
        expect(f.provider.refund).not.toHaveBeenCalled();
    });

    it('rejects unpaid or expired orders before channel submission', async () => {
        const f = await setup();
        jest.setSystemTime(NOW + 31 * DAY);
        await expect(
            f.refunds.create({ orderId: f.order.id }),
        ).rejects.toThrow();
        f.rows('order')[0].status = 'PENDING';
        await expect(f.refunds.create({ orderId: f.order.id })).rejects.toThrow(
            'status PENDING',
        );
        expect(f.provider.refund).not.toHaveBeenCalled();
    });

    it('returns a safe member-visible projection', async () => {
        const f = await setup();
        await pending(f);
        const views = await f.refunds.listForOrder(f.order.id, 'buyer');
        expect(views).toHaveLength(1);
        expect(views[0]).not.toHaveProperty('rawResponse');
        expect(views[0]).not.toHaveProperty('approvedBy');
        await expect(
            f.refunds.listForOrder(f.order.id, 'outsider'),
        ).rejects.toThrow();
    });
});
