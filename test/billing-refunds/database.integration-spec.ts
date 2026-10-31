import 'reflect-metadata';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { PrismaService } from '../../src/infra/database/prisma.service';
import { RefundService } from '../../src/modules/billing/refund/refund.service';
import { settlePaidOrder } from '../../src/modules/billing/payment/payment-settlement';
import { EffectivePlanService } from '../../src/shared/subscription/effective-plan.service';
import { DEFAULT_REFUND_RUNTIME_CONFIG } from '../../src/modules/billing/refund/refund-config.service';
import {
    assertEmptyDatabase,
    deployMigrations,
    root,
    validateTestUrl,
} from '../monitor-postgres/harness';

// Explicit disposable local URL only; never falls back to the application DB.
void test('refund admission and settlement with real PostgreSQL', async (t) => {
    const url = validateTestUrl(process.env.MONITOR_TEST_DATABASE_URL);
    const sql = new Client({ connectionString: url });
    let db: PrismaService | undefined;
    try {
        await sql.connect();
        await assertEmptyDatabase(sql);
        await deployMigrations(url, join(root, 'prisma/migrations'));
        db = new PrismaService(
            new ConfigService({
                database: { url },
                app: { isDevelopment: false },
            }),
        );
        await db.$connect();
        const prisma = db;
        const user = await prisma.user.create({
            data: {
                name: 'Refund test',
                email: 'refund@example.invalid',
                password: 'test-only',
            },
        });
        const plan = await prisma.plan.create({
            data: { code: 'REFUND_TEST', name: 'Refund test' },
        });
        let sequence = 0;
        async function fixture(
            options: { manual?: boolean; legacy?: boolean } = {},
        ) {
            sequence++;
            const org = await prisma.organization.create({
                data: {
                    name: 'Refund test',
                    slug: `refund-${sequence}`,
                    ownerId: user.id,
                },
            });
            await prisma.membership.create({
                data: {
                    userId: user.id,
                    organizationId: org.id,
                    role: 'OWNER',
                },
            });
            const now = new Date();
            const startsAt = new Date(+now - 10 * 86_400_000);
            const endsAt = new Date(+startsAt + 30 * 86_400_000);
            const order = await prisma.order.create({
                data: {
                    orderNo: `REFUND_TEST_${sequence}`,
                    organizationId: org.id,
                    userId: user.id,
                    planId: plan.id,
                    cycle: 'MONTHLY',
                    amount: 2900,
                    durationDays: 30,
                    status: 'PAID',
                    paidAt: startsAt,
                    expiresAt: now,
                    serviceStartsAt: startsAt,
                    serviceEndsAt: endsAt,
                },
            });
            await prisma.payment.create({
                data: {
                    orderId: order.id,
                    channel: 'WECHAT',
                    status: 'SUCCESS',
                    amount: 2900,
                    outTradeNo: order.orderNo,
                },
            });
            const sub = await prisma.subscription.create({
                data: {
                    organizationId: org.id,
                    planId: plan.id,
                    orderId: order.id,
                    startsAt,
                    expiresAt: endsAt,
                    status: 'ACTIVE',
                    entitlementsTracked: !options.legacy,
                },
            });
            if (!options.legacy)
                await prisma.subscriptionEntitlement.create({
                    data: {
                        orderId: order.id,
                        subscriptionId: sub.id,
                        startsAt,
                        endsAt,
                    },
                });
            const calls: Record<string, unknown>[] = [];
            let channelStatus = 'PROCESSING';
            let notices = 0;
            const provider = {
                refund: (input: Record<string, unknown>) => {
                    calls.push(input);
                    return Promise.resolve({ status: channelStatus });
                },
            };
            const service = new RefundService(
                prisma,
                { getRefundProvider: () => provider } as never,
                {
                    organizationRecipients: () => Promise.resolve([]),
                    publish: () => {
                        notices++;
                        return Promise.resolve();
                    },
                } as never,
                {
                    getEffectivePlanInTransaction: () => Promise.resolve(null),
                } as never,
                {
                    config: () =>
                        Promise.resolve({
                            ...DEFAULT_REFUND_RUNTIME_CONFIG,
                            enabled: true,
                            userSelfService: true,
                            autoApproveLimit: options.manual ? 0 : 10000,
                        }),
                } as never,
            );
            return {
                service,
                order,
                sub,
                calls,
                setStatus: (value: string) => {
                    channelStatus = value;
                },
                notices: () => notices,
            };
        }
        const fulfilled = (results: PromiseSettledResult<unknown>[]) =>
            results.filter((r) => r.status === 'fulfilled').length;

        await t.test(
            'concurrent creates admit one request and the DB index protects direct writes',
            async () => {
                const f = await fixture();
                assert.equal(
                    fulfilled(
                        await Promise.allSettled(
                            Array.from({ length: 8 }, () =>
                                f.service.create({ orderId: f.order.id }),
                            ),
                        ),
                    ),
                    1,
                );
                assert.equal(f.calls.length, 1);
                assert.equal(
                    await prisma.refund.count({
                        where: { orderId: f.order.id },
                    }),
                    1,
                );
                await assert.rejects(
                    prisma.refund.create({
                        data: {
                            refundNo: 'DIRECT_DUPLICATE',
                            organizationId: f.order.organizationId,
                            orderId: f.order.id,
                            channel: 'WECHAT',
                            type: 'FULL',
                            amount: 2900,
                            status: 'PENDING',
                        },
                    }),
                    (error: { code: string }) => error.code === 'P2002',
                );
            },
        );

        await t.test(
            'concurrent approvals submit once; submitted requests cannot close',
            async () => {
                const f = await fixture({ manual: true });
                const refund = await f.service.create({
                    orderId: f.order.id,
                    origin: 'USER',
                    actorUserId: user.id,
                });
                assert.equal(refund.status, 'PENDING');
                assert.equal(
                    fulfilled(
                        await Promise.allSettled(
                            Array.from({ length: 4 }, () =>
                                f.service.approve(refund.id, user.id),
                            ),
                        ),
                    ),
                    1,
                );
                assert.equal(f.calls.length, 1);
                await assert.rejects(f.service.markClosed(refund.id));
            },
        );

        await t.test(
            'retry races with a fresh request under the same organization lock',
            async () => {
                const f = await fixture();
                f.setStatus('FAILED');
                const first = await f.service.create({ orderId: f.order.id });
                assert.equal(first.status, 'FAILED');
                f.setStatus('PROCESSING');
                const results = await Promise.allSettled([
                    f.service.retry(first.id),
                    f.service.create({ orderId: f.order.id }),
                    f.service.retry(first.id),
                ]);
                assert.equal(fulfilled(results), 1);
                assert.equal(f.calls.length, 2);
                assert.equal(
                    await prisma.refund.count({
                        where: {
                            orderId: f.order.id,
                            status: {
                                in: ['PENDING', 'PROCESSING', 'SUCCESS'],
                            },
                        },
                    }),
                    1,
                );
            },
        );

        await t.test(
            'simultaneous successful callbacks settle balances and service once',
            async () => {
                const f = await fixture();
                const refund = await f.service.create({ orderId: f.order.id });
                await Promise.all(
                    Array.from({ length: 4 }, () =>
                        f.service.markSuccess(refund.id),
                    ),
                );
                assert.equal(
                    (
                        await prisma.order.findUniqueOrThrow({
                            where: { id: f.order.id },
                        })
                    ).refundedAmount,
                    refund.amount,
                );
                assert.equal(
                    (
                        await prisma.payment.findUniqueOrThrow({
                            where: { orderId: f.order.id },
                        })
                    ).refundedAmount,
                    refund.amount,
                );
                const entitlement =
                    await prisma.subscriptionEntitlement.findUniqueOrThrow({
                        where: { orderId: f.order.id },
                    });
                assert.equal(+entitlement.endsAt, +entitlement.startsAt);
                assert.equal(f.notices(), 1);
            },
        );

        await t.test(
            'a real paid renewal survives a refund of its root purchase',
            async () => {
                const f = await fixture();
                const renewal = await prisma.order.create({
                    data: {
                        orderNo: 'REAL_RENEWAL',
                        organizationId: f.order.organizationId,
                        userId: user.id,
                        planId: plan.id,
                        cycle: 'MONTHLY',
                        amount: 2900,
                        durationDays: 30,
                        expiresAt: new Date(),
                    },
                });
                const pay = await prisma.payment.create({
                    data: {
                        orderId: renewal.id,
                        channel: 'WECHAT',
                        status: 'SUCCESS',
                        amount: 2900,
                    },
                });
                await prisma.$transaction((tx) =>
                    settlePaidOrder(tx, {
                        order: renewal,
                        paymentId: pay.id,
                        notifications: {
                            organizationRecipients: () => Promise.resolve([]),
                            publish: () => Promise.resolve(),
                        } as never,
                    }),
                );
                const snapshot = await prisma.order.findUniqueOrThrow({
                    where: { id: renewal.id },
                });
                const refund = await f.service.create({ orderId: f.order.id });
                await f.service.markSuccess(refund.id);
                const sub = await prisma.subscription.findUniqueOrThrow({
                    where: { id: f.sub.id },
                });
                const entry =
                    await prisma.subscriptionEntitlement.findUniqueOrThrow({
                        where: { orderId: renewal.id },
                    });
                assert.equal(sub.status, 'ACTIVE');
                assert.equal(+entry.endsAt - +entry.startsAt, 30 * 86_400_000);
                assert.equal(+sub.expiresAt, +entry.endsAt);
                assert.ok(+entry.startsAt < +snapshot.serviceStartsAt!);
                const unchanged = await prisma.order.findUniqueOrThrow({
                    where: { id: renewal.id },
                });
                assert.equal(
                    +unchanged.serviceStartsAt!,
                    +snapshot.serviceStartsAt!,
                );
                assert.equal(
                    +unchanged.serviceEndsAt!,
                    +snapshot.serviceEndsAt!,
                );
            },
        );

        await t.test(
            'a mixed legacy carrier never invalidates an already-submitted refund',
            async () => {
                const f = await fixture();
                const refund = await f.service.create({ orderId: f.order.id });
                await prisma.subscription.update({
                    where: { id: f.sub.id },
                    data: {
                        status: 'PAUSED',
                        pausedAt: new Date(),
                        pausedRemainingDays: 20,
                    },
                });
                await prisma.subscription.create({
                    data: {
                        organizationId: f.order.organizationId,
                        planId: plan.id,
                        status: 'ACTIVE',
                        startsAt: new Date(Date.now() + 5 * 86_400_000),
                        expiresAt: new Date(Date.now() + 35 * 86_400_000),
                    },
                });
                await new EffectivePlanService(prisma, {
                    reconcile: () => Promise.resolve(),
                } as never).getEffectivePlan(f.order.organizationId);
                assert.equal(
                    (
                        await prisma.subscription.findUniqueOrThrow({
                            where: { id: f.sub.id },
                        })
                    ).status,
                    'PAUSED',
                );
                await f.service.markSuccess(refund.id);
                assert.equal(
                    (
                        await prisma.refund.findUniqueOrThrow({
                            where: { id: refund.id },
                        })
                    ).status,
                    'SUCCESS',
                );
            },
        );

        await t.test(
            'upgraded PROCESSING refunds hydrate legacy service before settlement',
            async () => {
                const f = await fixture({ legacy: true });
                const refund = await prisma.refund.create({
                    data: {
                        refundNo: 'LEGACY_PROCESSING',
                        organizationId: f.order.organizationId,
                        orderId: f.order.id,
                        channel: 'WECHAT',
                        type: 'PRORATED',
                        amount: 1900,
                        status: 'PROCESSING',
                        submittedAt: new Date(),
                    },
                });
                await f.service.markSuccess(refund.id);
                assert.equal(
                    (
                        await prisma.refund.findUniqueOrThrow({
                            where: { id: refund.id },
                        })
                    ).status,
                    'SUCCESS',
                );
                assert.equal(
                    (
                        await prisma.subscription.findUniqueOrThrow({
                            where: { id: f.sub.id },
                        })
                    ).entitlementsTracked,
                    true,
                );
            },
        );
    } finally {
        await db?.$disconnect();
        await sql.end();
    }
});
