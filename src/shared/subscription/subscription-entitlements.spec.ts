import { billingPaymentFixture } from '../../../test/fixtures/billing-payment.fixture';
import { EffectivePlanService } from './effective-plan.service';
import {
    checkpointEntitlements,
    trackSubscriptionEntitlements,
} from './subscription-entitlements';

const DAY = 86_400_000;
const NOW = +new Date('2026-10-31T00:00:00Z');
const at = (day: number) => new Date(NOW + day * DAY);
async function purchase(f: ReturnType<typeof billingPaymentFixture>) {
    const order = await f.newOrder();
    const pay = await f.payments.createPayment(order.id, 'buyer', {
        openid: 'o',
    });
    await f.payments.handleWechatCallback(
        JSON.stringify(f.paid(pay.outTradeNo)),
        'verified',
    );
    return f.rows('order').find((row) => row.id === order.id);
}
async function setup() {
    const f = billingPaymentFixture();
    const first = await purchase(f);
    return { ...f, first };
}
async function freeze(f: Awaited<ReturnType<typeof setup>>, day: number) {
    const sub = f.rows('subscription')[0];
    await checkpointEntitlements(f.prisma, sub.id, at(day));
    Object.assign(sub, {
        status: 'PAUSED',
        pausedAt: at(day),
        pausedRemainingDays: Math.ceil((+sub.expiresAt - +at(day)) / DAY),
    });
}
function effective(f: Awaited<ReturnType<typeof setup>>) {
    return new EffectivePlanService(f.prisma, {
        reconcile: jest.fn(),
    } as never);
}

describe('Per-order service entitlements', () => {
    beforeEach(() => jest.useFakeTimers({ now: NOW }));
    afterEach(() => jest.useRealTimers());

    it.each([0, 1, 2])(
        'reclaims only order %s from a first purchase plus two renewals',
        async (index) => {
            const f = await setup();
            const second = await purchase(f);
            const third = await purchase(f);
            const orders = [f.first, second, third];
            const snapshots = structuredClone(orders);
            jest.setSystemTime(at(10));
            const refund = await f.refunds.create({
                orderId: orders[index].id,
            });
            await f.refunds.markSuccess(refund.id);
            const sub = f.rows('subscription')[0];
            expect(sub.status).toBe('ACTIVE');
            expect(sub.expiresAt).toEqual(at(index === 0 ? 70 : 60));
            const own = f
                .rows('subscriptionEntitlement')
                .find((row) => row.orderId === orders[index].id);
            expect(own.endsAt).toEqual(own.startsAt);
            expect(Number(own.consumedMs)).toBe(index === 0 ? 10 * DAY : 0);
            const remaining = f
                .rows('subscriptionEntitlement')
                .filter((row) => row.orderId !== orders[index].id);
            expect(
                remaining.map((row) => [+row.startsAt, +row.endsAt]),
            ).toEqual(
                index === 0
                    ? [
                          [+at(10), +at(40)],
                          [+at(40), +at(70)],
                      ]
                    : [
                          [+at(10), +at(30)],
                          [+at(30), +at(60)],
                      ],
            );
            for (const snapshot of snapshots) {
                const order = f
                    .rows('order')
                    .find((row) => row.id === snapshot.id);
                expect(order.serviceStartsAt).toEqual(snapshot.serviceStartsAt);
                expect(order.serviceEndsAt).toEqual(snapshot.serviceEndsAt);
            }
            const tail = orders[index === 2 ? 1 : 2];
            jest.setSystemTime(at(45));
            const { quote } = await f.refunds.quote(tail.id);
            expect(quote.usedDays).toBe(index === 0 ? 5 : 15);
            expect(quote.remainingDays).toBe(index === 0 ? 25 : 15);
        },
    );

    it('checkpoints service usage when a paid higher plan freezes the existing plan', async () => {
        const f = await setup();
        const original = f.rows('subscription')[0];
        const higherId = 'c223456789012345678901234';
        f.rows('plan').push({
            ...structuredClone(f.rows('plan')[0]),
            id: higherId,
            code: 'TEAM',
            sortOrder: 2,
        });
        jest.setSystemTime(at(10.25));
        const high = await f.orders.create('org', 'buyer', {
            planId: higherId,
        });
        const payment = await f.payments.createPayment(high.id, 'buyer', {
            openid: 'o',
        });
        await f.payments.handleWechatCallback(
            JSON.stringify(f.paid(payment.outTradeNo)),
            'verified',
        );
        expect(
            f.rows('subscription').find((row) => row.id === original.id),
        ).toMatchObject({ status: 'PAUSED', pausedAt: at(10.25) });
        expect(
            f
                .rows('subscriptionEntitlement')
                .find((row) => row.orderId === f.first.id),
        ).toMatchObject({
            consumedMs: BigInt(10.25 * DAY),
            startsAt: at(10.25),
        });
        jest.setSystemTime(at(70));
        expect((await f.refunds.quote(f.first.id)).quote).toMatchObject({
            usedDays: 11,
            remainingDays: 19,
        });
        await effective(f).getEffectivePlan('org');
        expect(
            f.rows('subscription').find((row) => row.id === original.id),
        ).toMatchObject({
            status: 'ACTIVE',
            startsAt: at(70),
            expiresAt: at(89.75),
        });
    });

    it('does not consume a paused order while waiting, including future renewals', async () => {
        const f = await setup();
        const renewal = await purchase(f);
        await freeze(f, 10);
        jest.setSystemTime(at(70));
        expect((await f.refunds.quote(f.first.id)).quote).toMatchObject({
            usedDays: 10,
            remainingDays: 20,
            amount: 1933,
        });
        expect((await f.refunds.quote(renewal.id)).quote).toMatchObject({
            policyCode: 'NOT_STARTED',
            usedDays: 0,
            remainingDays: 30,
            amount: 2900,
        });
        const refund = await f.refunds.create({ orderId: f.first.id });
        await f.refunds.markSuccess(refund.id);
        expect(f.rows('subscription')[0]).toMatchObject({
            status: 'PAUSED',
            pausedRemainingDays: 30,
            expiresAt: at(40),
        });
    });

    it('resumes exact remaining milliseconds and retains usage for later quotes', async () => {
        const f = await setup();
        await freeze(f, 10.25);
        jest.setSystemTime(at(70));
        await effective(f).getEffectivePlan('org');
        expect(f.rows('subscription')[0]).toMatchObject({
            status: 'ACTIVE',
            startsAt: at(70),
            expiresAt: at(89.75),
        });
        expect((await f.refunds.quote(f.first.id)).quote).toMatchObject({
            usedDays: 11,
            remainingDays: 19,
        });
        jest.setSystemTime(at(72));
        expect((await f.refunds.quote(f.first.id)).quote).toMatchObject({
            usedDays: 13,
            remainingDays: 17,
        });
    });

    it('preserves consumed time when a paused interval merges behind a future same-plan tail', async () => {
        const f = await setup();
        await freeze(f, 10);
        jest.setSystemTime(at(70));
        // A same-plan queued subscription created while the first was frozen.
        const queuedOrder = await f.prisma.order.create({
            data: {
                ...f.first,
                id: 'queued-order',
                orderNo: 'QUEUE',
                serviceStartsAt: at(75),
                serviceEndsAt: at(105),
            },
        });
        const queued = await f.prisma.subscription.create({
            data: {
                organizationId: 'org',
                planId: f.first.planId,
                status: 'ACTIVE',
                startsAt: at(75),
                expiresAt: at(105),
                orderId: queuedOrder.id,
                entitlementsTracked: true,
            },
        });
        await f.prisma.subscriptionEntitlement.create({
            data: {
                orderId: queuedOrder.id,
                subscriptionId: queued.id,
                startsAt: at(75),
                endsAt: at(105),
            },
        });
        await effective(f).getEffectivePlan('org');
        const entry = f
            .rows('subscriptionEntitlement')
            .find((row) => row.orderId === f.first.id);
        expect(entry).toMatchObject({
            subscriptionId: queued.id,
            startsAt: at(105),
            endsAt: at(125),
            consumedMs: BigInt(10 * DAY),
        });
        expect((await f.refunds.quote(f.first.id)).quote).toMatchObject({
            policyCode: 'PRORATED',
            usedDays: 10,
            remainingDays: 20,
            amount: 1933,
        });
        const refund = await f.refunds.create({ orderId: f.first.id });
        await f.refunds.markSuccess(refund.id);
        expect(
            f.rows('subscription').find((row) => row.id === queued.id)
                .expiresAt,
        ).toEqual(at(105));
    });

    it.each([true, false])(
        'retains already-submitted refunds when a mixed carrier cannot merge (sourceTracked=%s)',
        async (sourceTracked) => {
            const f = await setup();
            await freeze(f, 10);
            jest.setSystemTime(at(70));
            const source = f.rows('subscription')[0];
            const targetOrder = await f.prisma.order.create({
                data: {
                    ...f.first,
                    id: 'mixed-target-order',
                    orderNo: 'MIXED',
                    serviceStartsAt: at(75),
                    serviceEndsAt: at(105),
                },
            });
            const target = await f.prisma.subscription.create({
                data: {
                    organizationId: 'org',
                    planId: f.first.planId,
                    status: 'ACTIVE',
                    startsAt: at(75),
                    expiresAt: at(105),
                    orderId: targetOrder.id,
                    entitlementsTracked: !sourceTracked,
                },
            });
            if (sourceTracked) {
                // Cannot prove target service history from its financial snapshot.
                f
                    .rows('subscription')
                    .find((row) => row.id === target.id).startsAt = at(76);
            } else {
                source.entitlementsTracked = false;
                source.orderId = null;
                f.rows('subscriptionEntitlement').splice(0);
                await f.prisma.subscriptionEntitlement.create({
                    data: {
                        orderId: targetOrder.id,
                        subscriptionId: target.id,
                        startsAt: at(75),
                        endsAt: at(105),
                    },
                });
            }
            const trackedOrder = sourceTracked ? f.first : targetOrder;
            if (!sourceTracked)
                await f.prisma.payment.create({
                    data: {
                        ...f.rows('payment')[0],
                        id: 'mixed-target-payment',
                        orderId: targetOrder.id,
                        outTradeNo: 'MIXED',
                    },
                });
            const refund = await f.refunds.create({ orderId: trackedOrder.id });
            await effective(f).getEffectivePlan('org');
            expect(
                f.rows('subscription').find((row) => row.id === source.id)
                    .status,
            ).toBe('PAUSED');
            const known = f
                .rows('subscriptionEntitlement')
                .find((row) => row.orderId === trackedOrder.id);
            expect(known.subscriptionId).toBe(
                sourceTracked ? source.id : target.id,
            );
            await f.refunds.markSuccess(refund.id);
            expect(f.rows('refund')[0].status).toBe('SUCCESS');
            expect(
                f
                    .rows('subscription')
                    .find(
                        (row) =>
                            row.id === (sourceTracked ? source.id : target.id),
                    )?.entitlementsTracked,
            ).toBe(true);
        },
    );

    it('resumes a separate tracked carrier after the untracked same-plan carrier expires', async () => {
        const f = await setup();
        await freeze(f, 10);
        const source = f.rows('subscription')[0];
        const target = await f.prisma.subscription.create({
            data: {
                organizationId: 'org',
                planId: f.first.planId,
                status: 'ACTIVE',
                startsAt: at(75),
                expiresAt: at(105),
                orderId: null,
            },
        });
        jest.setSystemTime(at(70));
        await effective(f).getEffectivePlan('org');
        expect(f.rows('subscription')[0].status).toBe('PAUSED');
        jest.setSystemTime(at(105));
        await effective(f).getEffectivePlan('org');
        expect(
            f.rows('subscription').find((row) => row.id === source.id),
        ).toMatchObject({
            status: 'ACTIVE',
            startsAt: at(105),
            expiresAt: at(125),
            entitlementsTracked: true,
        });
        expect(
            f.rows('subscription').find((row) => row.id === target.id)
                .entitlementsTracked,
        ).toBe(false);
    });

    it('reclaims precise service duration even though pricing rounds consumption to days', async () => {
        const f = await setup();
        await purchase(f);
        jest.setSystemTime(at(10.25));
        const refund = await f.refunds.create({ orderId: f.first.id });
        expect(refund.usedDays).toBe(11);
        await f.refunds.markSuccess(refund.id);
        expect(f.rows('subscription')[0].expiresAt).toEqual(at(40.25));
    });

    it('hydrates a continuous legacy stack before settling an already-submitted refund', async () => {
        const f = await setup();
        await purchase(f);
        f.rows('subscriptionEntitlement').splice(0);
        f.rows('subscription')[0].entitlementsTracked = false;
        const refund = await f.prisma.refund.create({
            data: {
                refundNo: 'LEGACY',
                orderId: f.first.id,
                organizationId: 'org',
                channel: 'WECHAT',
                status: 'PROCESSING',
                submittedAt: at(0),
                amount: 1933,
            },
        });
        jest.setSystemTime(at(10));
        await f.refunds.markSuccess(refund.id);
        expect(f.rows('refund')[0].status).toBe('SUCCESS');
        expect(f.rows('subscriptionEntitlement')).toHaveLength(2);
        expect(f.rows('subscription')[0].expiresAt).toEqual(at(40));
    });

    it.each([
        'missing-snapshot',
        'restored',
        'overlap',
        'foreign-root',
        'partial-ledger',
    ])(
        'requires reconciliation for ambiguous legacy history: %s',
        async (kind) => {
            const f = await setup();
            await purchase(f);
            const sub = f.rows('subscription')[0];
            sub.entitlementsTracked = false;
            if (kind !== 'partial-ledger')
                f.rows('subscriptionEntitlement').splice(0);
            if (kind === 'missing-snapshot') f.first.serviceStartsAt = null;
            if (kind === 'restored') sub.startsAt = at(5);
            if (kind === 'overlap') f.rows('order')[1].serviceStartsAt = at(20);
            if (kind === 'foreign-root') sub.orderId = 'unknown-order';
            expect(
                (await f.refunds.quote(f.first.id)).quote.requiresManualReview,
            ).toBe(true);
            await expect(
                f.refunds.create({ orderId: f.first.id }),
            ).rejects.toThrow('manual reconciliation');
            expect(f.provider.refund).not.toHaveBeenCalled();
        },
    );

    it('rejects a ledger carrier from a different tenant or plan', async () => {
        const f = await setup();
        f.rows('subscription')[0].organizationId = 'other';
        await expect(f.refunds.quote(f.first.id)).rejects.toThrow(
            'manual reconciliation',
        );
        f.rows('subscription')[0].organizationId = 'org';
        f.rows('subscription')[0].planId = 'other-plan';
        await expect(f.refunds.quote(f.first.id)).rejects.toThrow(
            'manual reconciliation',
        );
    });

    it('legacy hydration is idempotent', async () => {
        const f = await setup();
        const sub = f.rows('subscription')[0];
        f.rows('subscriptionEntitlement').splice(0);
        sub.entitlementsTracked = false;
        await f.prisma.$transaction(async (tx) => {
            expect(await trackSubscriptionEntitlements(tx, sub)).toBe(true);
        });
        await f.prisma.$transaction(async (tx) => {
            expect(
                await trackSubscriptionEntitlements(
                    tx,
                    f.rows('subscription')[0],
                ),
            ).toBe(true);
        });
        expect(f.rows('subscriptionEntitlement')).toHaveLength(1);
    });

    it('can settle a historical submission even after the service expires', async () => {
        const f = await setup();
        f.rows('subscriptionEntitlement').splice(0);
        Object.assign(f.rows('subscription')[0], {
            entitlementsTracked: false,
            status: 'EXPIRED',
        });
        const refund = await f.prisma.refund.create({
            data: {
                refundNo: 'LATE',
                orderId: f.first.id,
                organizationId: 'org',
                channel: 'WECHAT',
                status: 'PROCESSING',
                submittedAt: at(1),
                amount: 2900,
            },
        });
        jest.setSystemTime(at(70));
        await f.refunds.markSuccess(refund.id);
        expect(f.rows('refund')[0].status).toBe('SUCCESS');
        expect(f.rows('subscription')[0].status).toBe('EXPIRED');
    });
});
