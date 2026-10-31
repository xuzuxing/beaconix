import {
    NotificationType,
    OrderStatus,
    PaymentChannel,
    PaymentStatus,
    RefundStatus,
    RefundType,
    SubscriptionStatus,
} from '../../../generated/prisma/enums';
import type { OrderModel, RefundModel } from '../../../generated/prisma/models';
import type { EffectivePlanService } from '../../../shared/subscription/effective-plan.service';
import type { NotificationsService } from '../../notifications/notifications.service';
import type { PrismaService } from '../../../infra/database/prisma.service';
import type { PaymentProviderFactory } from '../payment/payment-provider.factory';
import {
    DEFAULT_REFUND_RUNTIME_CONFIG,
    type RefundRuntimeConfig,
} from './refund-config.service';
import type { RefundConfigService } from './refund-config.service';
import { RefundService } from './refund.service';

const DAY_MS = 24 * 60 * 60 * 1000;
// 基准必须相对「现在」：`markSuccess` 内部用的是真实 `new Date()`，写死的
// 历史日期会让「未开始/续费回退」分支全部走错。取整到秒消除毫秒误差。
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
/** 服务期起点：10 天前（即当前时刻已用 10 天）。 */
const T0 = new Date(NOW.getTime() - 10 * DAY_MS);
const at = (days: number) => new Date(T0.getTime() + days * DAY_MS);

function makeOrder(overrides: Partial<OrderModel> = {}): OrderModel {
    return {
        id: 'order-1',
        orderNo: 'BW1',
        organizationId: 'org-1',
        planId: 'plan-pro',
        userId: 'user-1',
        amount: 29900,
        currency: 'CNY',
        durationDays: 30,
        cycle: 'MONTHLY',
        termId: 'term-1',
        status: OrderStatus.PAID,
        paidAt: T0,
        cancelledAt: null,
        expiresAt: at(1),
        serviceStartsAt: T0,
        serviceEndsAt: at(30),
        refundedAmount: 0,
        createdAt: T0,
        updatedAt: T0,
        ...overrides,
    };
}

function makeRefund(overrides: Partial<RefundModel> = {}): RefundModel {
    return {
        id: 'refund-1',
        refundNo: 'RF1',
        orderId: 'order-1',
        organizationId: 'org-1',
        channel: PaymentChannel.WECHAT,
        type: RefundType.PRORATED,
        status: RefundStatus.PENDING,
        amount: 19933,
        settledAmount: null,
        policyCode: 'PRORATED',
        usedDays: 10,
        remainingDays: 20,
        reason: null,
        requestedBy: null,
        approvedBy: null,
        channelRefundId: null,
        failureReason: null,
        rawResponse: null,
        refundedAt: null,
        createdAt: T0,
        updatedAt: T0,
        ...overrides,
    };
}

const payment = {
    id: 'payment-1',
    orderId: 'order-1',
    channel: PaymentChannel.WECHAT,
    transactionId: 'wx-tx-1',
    prepayId: null,
    amount: 29900,
    refundedAmount: 0,
    status: PaymentStatus.SUCCESS,
    paidAt: T0,
    rawCallback: null,
    createdAt: T0,
    updatedAt: T0,
};

function createService(config: Partial<RefundRuntimeConfig> = {}) {
    const prisma = {
        order: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
        payment: { findUnique: jest.fn(), updateMany: jest.fn() },
        membership: { findUnique: jest.fn() },
        subscription: { findFirst: jest.fn().mockResolvedValue(null) },
        refund: {
            create: jest.fn(),
            findFirst: jest.fn().mockResolvedValue(null),
            findMany: jest.fn().mockResolvedValue([]),
            findUnique: jest.fn(),
            findUniqueOrThrow: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
        },
        $transaction: jest.fn(),
    };
    const provider = {
        refund: jest.fn(),
        queryRefund: jest.fn(),
        parseRefundCallback: jest.fn(),
    };
    const providers = {
        get: jest.fn().mockReturnValue(provider),
        getRefundProvider: jest.fn().mockReturnValue(provider),
    };
    const notifications = {
        publish: jest.fn().mockResolvedValue(undefined),
        organizationRecipients: jest.fn().mockResolvedValue(['owner']),
    };
    const effectivePlan = {
        getEffectivePlanInTransaction: jest.fn().mockResolvedValue(null),
    };
    const refundConfig = {
        config: jest.fn().mockResolvedValue({
            ...DEFAULT_REFUND_RUNTIME_CONFIG,
            enabled: true,
            ...config,
        }),
    };

    const service = new RefundService(
        prisma as unknown as PrismaService,
        providers as unknown as PaymentProviderFactory,
        notifications as unknown as NotificationsService,
        effectivePlan as unknown as EffectivePlanService,
        refundConfig as unknown as RefundConfigService,
    );

    return {
        service,
        prisma,
        provider,
        providers,
        notifications,
        effectivePlan,
        refundConfig,
    };
}

/** `$transaction` 的回调参数。 */
function makeTx() {
    return {
        $queryRaw: jest.fn(),
        refund: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        order: {
            findUniqueOrThrow: jest.fn().mockResolvedValue(makeOrder()),
            update: jest.fn(),
        },
        payment: { updateMany: jest.fn() },
        subscription: {
            findFirst: jest.fn().mockResolvedValue(null),
            update: jest.fn(),
        },
    };
}

function wireTransaction(
    prisma: ReturnType<typeof createService>['prisma'],
    tx: ReturnType<typeof makeTx>,
) {
    prisma.$transaction.mockImplementation(
        (callback: (client: typeof tx) => unknown) => callback(tx),
    );
}

describe('RefundService', () => {
    describe('quote', () => {
        it('prorates by unused days', async () => {
            const { service, prisma } = createService();
            prisma.order.findUnique.mockResolvedValue(makeOrder());

            const { quote } = await service.quote('order-1', at(10));

            expect(quote).toMatchObject({
                eligible: true,
                policyCode: 'PRORATED',
                usedDays: 10,
                remainingDays: 20,
                amount: 19933,
            });
        });

        it('marks the quote as cancellation for a queued segment', async () => {
            const { service, prisma } = createService();
            prisma.order.findUnique.mockResolvedValue(
                makeOrder({
                    serviceStartsAt: at(40),
                    serviceEndsAt: at(70),
                }),
            );
            prisma.subscription.findFirst.mockResolvedValue({ id: 'sub-1' });

            const { quote } = await service.quote('order-1', at(10));

            expect(quote).toMatchObject({
                policyCode: 'NOT_STARTED',
                subscriptionEffect: 'CANCEL_PENDING',
            });
        });

        it('rejects an unknown order', async () => {
            const { service, prisma } = createService();
            prisma.order.findUnique.mockResolvedValue(null);

            await expect(service.quote('order-404')).rejects.toThrow(
                'Order not found',
            );
        });

        it('rejects a user outside the organization', async () => {
            const ctx = createService();
            ctx.prisma.order.findUnique.mockResolvedValue(makeOrder());
            ctx.prisma.membership.findUnique.mockResolvedValue(null);

            await expect(
                ctx.service.quote('order-1', at(10), 'outsider'),
            ).rejects.toThrow('Order not found');
        });

        it('accepts a member of the organization', async () => {
            const ctx = createService();
            ctx.prisma.order.findUnique.mockResolvedValue(makeOrder());
            ctx.prisma.membership.findUnique.mockResolvedValue({ id: 'm1' });

            const { quote } = await ctx.service.quote(
                'order-1',
                at(10),
                'user-1',
            );

            expect(quote.amount).toBe(19933);
        });
    });

    describe('create', () => {
        function wireHappyPath(
            ctx: ReturnType<typeof createService>,
            refund = makeRefund(),
        ) {
            ctx.prisma.order.findUnique.mockResolvedValue(makeOrder());
            ctx.prisma.payment.findUnique.mockResolvedValue(payment);
            ctx.prisma.refund.create.mockResolvedValue(refund);
            ctx.prisma.refund.findUnique.mockResolvedValue(refund);
            ctx.prisma.refund.findUniqueOrThrow.mockResolvedValue(
                makeRefund({ status: RefundStatus.SUCCESS }),
            );
            const tx = makeTx();
            wireTransaction(ctx.prisma, tx);

            return tx;
        }

        it('refuses everything while the feature flag is off', async () => {
            const ctx = createService({ enabled: false });
            ctx.prisma.order.findUnique.mockResolvedValue(makeOrder());

            await expect(
                ctx.service.create({ orderId: 'order-1' }),
            ).rejects.toThrow('Refunds are disabled');
            expect(ctx.prisma.refund.create).not.toHaveBeenCalled();
        });

        it('refuses an order that is not PAID', async () => {
            const ctx = createService();
            ctx.prisma.order.findUnique.mockResolvedValue(
                makeOrder({ status: OrderStatus.PENDING }),
            );

            await expect(
                ctx.service.create({ orderId: 'order-1' }),
            ).rejects.toThrow('Cannot refund an order with status PENDING');
        });

        it('refuses an order without a successful payment', async () => {
            const ctx = createService();
            ctx.prisma.order.findUnique.mockResolvedValue(makeOrder());
            ctx.prisma.payment.findUnique.mockResolvedValue(null);

            await expect(
                ctx.service.create({ orderId: 'order-1' }),
            ).rejects.toThrow('Order has no successful payment');
        });

        it('routes virtual-payment refunds through their own provider', async () => {
            const ctx = createService();
            const tx = wireHappyPath(
                ctx,
                makeRefund({ channel: PaymentChannel.WECHAT_VIRTUAL }),
            );
            ctx.prisma.payment.findUnique.mockResolvedValue({
                ...payment,
                channel: PaymentChannel.WECHAT_VIRTUAL,
            });
            ctx.provider.refund.mockResolvedValue({ status: 'SUCCESS' });

            await ctx.service.create({ orderId: 'order-1' });

            expect(ctx.providers.getRefundProvider).toHaveBeenCalledWith(
                PaymentChannel.WECHAT_VIRTUAL,
            );
            // 虚拟支付要靠 orderId 找支付尝试（openid + 真实单号）
            expect(ctx.provider.refund).toHaveBeenCalledWith(
                expect.objectContaining({
                    orderId: 'order-1',
                    refundFee: 19933,
                }),
            );
            expect(tx.order.update).toHaveBeenCalled();
        });

        it('refuses a second refund while one is in flight', async () => {
            const ctx = createService();
            ctx.prisma.order.findUnique.mockResolvedValue(makeOrder());
            ctx.prisma.payment.findUnique.mockResolvedValue(payment);
            ctx.prisma.refund.findFirst.mockResolvedValue({
                status: RefundStatus.PROCESSING,
            });

            await expect(
                ctx.service.create({ orderId: 'order-1' }),
            ).rejects.toThrow('already in progress');
        });

        it('refuses an order that was already refunded', async () => {
            const ctx = createService();
            ctx.prisma.order.findUnique.mockResolvedValue(makeOrder());
            ctx.prisma.payment.findUnique.mockResolvedValue(payment);
            ctx.prisma.refund.findFirst.mockResolvedValue({
                status: RefundStatus.SUCCESS,
            });

            await expect(
                ctx.service.create({ orderId: 'order-1' }),
            ).rejects.toThrow('already been refunded');
        });

        it('refuses an expired order', async () => {
            const ctx = createService();
            ctx.prisma.order.findUnique.mockResolvedValue(
                makeOrder({
                    serviceStartsAt: at(-60),
                    serviceEndsAt: at(-30),
                }),
            );
            ctx.prisma.payment.findUnique.mockResolvedValue(payment);

            await expect(
                ctx.service.create({ orderId: 'order-1' }),
            ).rejects.toThrow('already ended');
        });

        it('submits the refund and settles it in one transaction', async () => {
            const ctx = createService();
            const tx = wireHappyPath(
                ctx,
                makeRefund({ reason: 'not satisfied', requestedBy: 'admin-1' }),
            );
            ctx.provider.refund.mockResolvedValue({
                status: 'SUCCESS',
                channelRefundId: 'wx-refund-1',
            });

            const result = await ctx.service.create({
                orderId: 'order-1',
                reason: 'not satisfied',
                requestedBy: 'admin-1',
            });

            expect(ctx.provider.refund).toHaveBeenCalledWith({
                outRefundNo: 'RF1',
                outTradeNo: 'BW1',
                orderId: 'order-1',
                transactionId: 'wx-tx-1',
                refundFee: 19933,
                totalFee: 29900,
                leftFee: 29900,
                reason: 'not satisfied',
            });
            expect(tx.order.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: {
                        status: OrderStatus.REFUNDED,
                        refundedAmount: { increment: 19933 },
                    },
                }),
            );
            expect(tx.payment.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: {
                        status: PaymentStatus.REFUNDED,
                        refundedAmount: { increment: 19933 },
                    },
                }),
            );
            expect(result).toMatchObject({ status: RefundStatus.SUCCESS });
        });

        it('keeps a channel PROCESSING answer as PROCESSING', async () => {
            const ctx = createService();
            const refund = makeRefund();
            ctx.prisma.order.findUnique.mockResolvedValue(makeOrder());
            ctx.prisma.payment.findUnique.mockResolvedValue(payment);
            ctx.prisma.refund.create.mockResolvedValue(refund);
            ctx.prisma.refund.findUniqueOrThrow.mockResolvedValue(
                makeRefund({ status: RefundStatus.PROCESSING }),
            );
            ctx.provider.refund.mockResolvedValue({
                status: 'PROCESSING',
                channelRefundId: 'wx-refund-1',
            });

            const result = await ctx.service.create({ orderId: 'order-1' });

            expect(ctx.prisma.refund.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: RefundStatus.PROCESSING,
                    }),
                }),
            );
            expect(result.status).toBe(RefundStatus.PROCESSING);
        });

        it('records a channel exception as FAILED so it can be retried', async () => {
            const ctx = createService();
            ctx.prisma.order.findUnique.mockResolvedValue(makeOrder());
            ctx.prisma.payment.findUnique.mockResolvedValue(payment);
            ctx.prisma.refund.create.mockResolvedValue(makeRefund());
            ctx.prisma.refund.findUniqueOrThrow.mockResolvedValue(
                makeRefund({ status: RefundStatus.FAILED }),
            );
            ctx.provider.refund.mockRejectedValue(
                new Error('seller balance is not enough'),
            );

            const result = await ctx.service.create({ orderId: 'order-1' });

            expect(ctx.prisma.refund.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: RefundStatus.FAILED,
                        failureReason: 'seller balance is not enough',
                    }),
                }),
            );
            expect(result.status).toBe(RefundStatus.FAILED);
        });

        it('accepts a manual amount up to what is still refundable', async () => {
            const ctx = createService();
            wireHappyPath(
                ctx,
                makeRefund({ type: RefundType.MANUAL, amount: 5000 }),
            );
            ctx.provider.refund.mockResolvedValue({ status: 'SUCCESS' });

            await ctx.service.create({
                orderId: 'order-1',
                type: RefundType.MANUAL,
                amount: 5000,
            });

            expect(ctx.prisma.refund.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        type: RefundType.MANUAL,
                        amount: 5000,
                        policyCode: 'MANUAL',
                    }),
                }),
            );
            expect(ctx.provider.refund).toHaveBeenCalledWith(
                expect.objectContaining({ refundFee: 5000 }),
            );
        });

        it('refuses a manual amount above the refundable limit', async () => {
            const ctx = createService();
            ctx.prisma.order.findUnique.mockResolvedValue(makeOrder());
            ctx.prisma.payment.findUnique.mockResolvedValue(payment);

            await expect(
                ctx.service.create({
                    orderId: 'order-1',
                    type: RefundType.MANUAL,
                    amount: 29901,
                }),
            ).rejects.toThrow('cannot exceed');
        });

        it('refuses a manual amount that is not a positive integer', async () => {
            const ctx = createService();
            ctx.prisma.order.findUnique.mockResolvedValue(makeOrder());
            ctx.prisma.payment.findUnique.mockResolvedValue(payment);

            await expect(
                ctx.service.create({
                    orderId: 'order-1',
                    type: RefundType.MANUAL,
                    amount: 10.5,
                }),
            ).rejects.toThrow('positive integer amount');
        });

        it('refuses a self-service request while the flag is off', async () => {
            const ctx = createService({ userSelfService: false });
            ctx.prisma.order.findUnique.mockResolvedValue(makeOrder());
            ctx.prisma.membership.findUnique.mockResolvedValue({ id: 'm1' });

            await expect(
                ctx.service.create({
                    orderId: 'order-1',
                    origin: 'USER',
                    actorUserId: 'user-1',
                    requestedBy: 'user-1',
                }),
            ).rejects.toThrow('Self-service refunds are disabled');
            expect(ctx.prisma.refund.create).not.toHaveBeenCalled();
        });

        it('accepts a self-service request once the flag is on', async () => {
            const ctx = createService({ userSelfService: true });
            ctx.prisma.order.findUnique.mockResolvedValue(makeOrder());
            ctx.prisma.membership.findUnique.mockResolvedValue({ id: 'm1' });
            ctx.prisma.payment.findUnique.mockResolvedValue(payment);
            ctx.prisma.refund.create.mockResolvedValue(
                makeRefund({ status: RefundStatus.PENDING }),
            );

            const result = await ctx.service.create({
                orderId: 'order-1',
                origin: 'USER',
                actorUserId: 'user-1',
                requestedBy: 'user-1',
            });

            // 归属校验先于一切：必须有这条查询
            expect(ctx.prisma.membership.findUnique).toHaveBeenCalledWith({
                where: {
                    userId_organizationId: {
                        userId: 'user-1',
                        organizationId: 'org-1',
                    },
                },
                select: { id: true },
            });
            expect(ctx.prisma.refund.create).toHaveBeenCalled();
            // 阈值默认 0：申请被记录，等运营审批
            expect(result.status).toBe(RefundStatus.PENDING);
        });

        it('parks a self-service request for approval when the threshold is 0', async () => {
            const ctx = createService({
                userSelfService: true,
                autoApproveLimit: 0,
            });
            ctx.prisma.order.findUnique.mockResolvedValue(makeOrder());
            ctx.prisma.membership.findUnique.mockResolvedValue({ id: 'm1' });
            ctx.prisma.payment.findUnique.mockResolvedValue(payment);
            ctx.prisma.refund.create.mockResolvedValue(
                makeRefund({ status: RefundStatus.PENDING }),
            );

            const result = await ctx.service.create({
                orderId: 'order-1',
                origin: 'USER',
                actorUserId: 'user-1',
            });

            expect(result.status).toBe(RefundStatus.PENDING);
            // 停在待审批：绝不能先打渠道
            expect(ctx.provider.refund).not.toHaveBeenCalled();
            expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
        });

        it('executes a self-service request under the auto-approve threshold', async () => {
            const ctx = createService({
                userSelfService: true,
                autoApproveLimit: 50000,
            });
            const tx = wireHappyPath(ctx);
            ctx.prisma.membership.findUnique.mockResolvedValue({ id: 'm1' });
            ctx.provider.refund.mockResolvedValue({ status: 'SUCCESS' });

            await ctx.service.create({
                orderId: 'order-1',
                origin: 'USER',
                actorUserId: 'user-1',
            });

            expect(ctx.provider.refund).toHaveBeenCalled();
            expect(tx.order.update).toHaveBeenCalled();
        });
    });

    describe('approve', () => {
        it('submits a pending refund and records the approver', async () => {
            const ctx = createService();
            const pending = makeRefund({ status: RefundStatus.PENDING });
            ctx.prisma.refund.findUnique.mockResolvedValue(pending);
            ctx.prisma.order.findUniqueOrThrow.mockResolvedValue(makeOrder());
            ctx.prisma.payment.findUnique.mockResolvedValue(payment);
            ctx.prisma.refund.update.mockResolvedValue({
                ...pending,
                approvedBy: 'admin-1',
            });
            ctx.prisma.refund.findUniqueOrThrow.mockResolvedValue(
                makeRefund({ status: RefundStatus.PROCESSING }),
            );
            ctx.provider.refund.mockResolvedValue({ status: 'PROCESSING' });

            const result = await ctx.service.approve('refund-1', 'admin-1');

            expect(ctx.prisma.refund.update).toHaveBeenCalledWith({
                where: { id: 'refund-1' },
                data: { approvedBy: 'admin-1' },
            });
            expect(ctx.provider.refund).toHaveBeenCalledWith(
                expect.objectContaining({ outRefundNo: 'RF1' }),
            );
            expect(result.status).toBe(RefundStatus.PROCESSING);
        });

        it('refuses to approve a refund that already left PENDING', async () => {
            const ctx = createService();
            ctx.prisma.refund.findUnique.mockResolvedValue(
                makeRefund({ status: RefundStatus.SUCCESS }),
            );

            await expect(
                ctx.service.approve('refund-1', 'admin-1'),
            ).rejects.toThrow('Only a pending refund can be approved');
            expect(ctx.provider.refund).not.toHaveBeenCalled();
        });
    });

    describe('listForOrder', () => {
        it('returns refunds without internal fields', async () => {
            const ctx = createService();
            ctx.prisma.order.findUnique.mockResolvedValue(makeOrder());
            ctx.prisma.membership.findUnique.mockResolvedValue({ id: 'm1' });
            ctx.prisma.refund.findMany.mockResolvedValue([
                makeRefund({
                    channelRefundId: 'wx-refund-1',
                    rawResponse: { secret: 'channel payload' },
                }),
            ]);

            const views = await ctx.service.listForOrder('order-1', 'user-1');

            expect(views).toHaveLength(1);
            expect(views[0]).toMatchObject({
                refundNo: 'RF1',
                amount: 19933,
                status: RefundStatus.PENDING,
            });
            expect(views[0]).not.toHaveProperty('rawResponse');
            expect(views[0]).not.toHaveProperty('channelRefundId');
            expect(views[0]).not.toHaveProperty('approvedBy');
        });

        it('hides refunds from users outside the organization', async () => {
            const ctx = createService();
            ctx.prisma.order.findUnique.mockResolvedValue(makeOrder());
            ctx.prisma.membership.findUnique.mockResolvedValue(null);

            await expect(
                ctx.service.listForOrder('order-1', 'outsider'),
            ).rejects.toThrow('Order not found');
            expect(ctx.prisma.refund.findMany).not.toHaveBeenCalled();
        });
    });

    describe('markSuccess', () => {
        it('is a no-op when the refund is already SUCCESS', async () => {
            const ctx = createService();
            ctx.prisma.refund.findUnique.mockResolvedValue(
                makeRefund({ status: RefundStatus.SUCCESS }),
            );

            await ctx.service.markSuccess('refund-1');

            expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
        });

        it('skips business work when a concurrent callback already settled', async () => {
            const ctx = createService();
            ctx.prisma.refund.findUnique.mockResolvedValue(makeRefund());
            const tx = makeTx();
            tx.refund.updateMany.mockResolvedValue({ count: 0 });
            wireTransaction(ctx.prisma, tx);

            await ctx.service.markSuccess('refund-1');

            expect(tx.order.update).not.toHaveBeenCalled();
            expect(ctx.notifications.publish).not.toHaveBeenCalled();
        });

        it('expires the subscription segment created by this order', async () => {
            const ctx = createService();
            ctx.prisma.refund.findUnique.mockResolvedValue(makeRefund());
            const tx = makeTx();
            tx.subscription.findFirst.mockResolvedValue({
                id: 'sub-1',
                startsAt: at(-10),
            });
            wireTransaction(ctx.prisma, tx);

            await ctx.service.markSuccess('refund-1');

            expect(tx.subscription.update).toHaveBeenCalledWith({
                where: { id: 'sub-1' },
                data: {
                    status: SubscriptionStatus.EXPIRED,
                    expiresAt: expect.any(Date),
                },
            });
        });

        it('cancels a queued segment that never started', async () => {
            const ctx = createService();
            ctx.prisma.refund.findUnique.mockResolvedValue(makeRefund());
            const tx = makeTx();
            tx.subscription.findFirst.mockResolvedValue({
                id: 'sub-1',
                startsAt: at(40),
            });
            wireTransaction(ctx.prisma, tx);

            await ctx.service.markSuccess('refund-1');

            expect(tx.subscription.update).toHaveBeenCalledWith({
                where: { id: 'sub-1' },
                data: {
                    status: SubscriptionStatus.CANCELLED,
                    expiresAt: at(40),
                },
            });
        });

        it('shrinks a renewed subscription by the unused days', async () => {
            const ctx = createService();
            ctx.prisma.refund.findUnique.mockResolvedValue(
                makeRefund({ remainingDays: 20 }),
            );
            const tx = makeTx();
            tx.subscription.findFirst
                // 第一次：这个订单没有自己的订阅段
                .mockResolvedValueOnce(null)
                // 第二次：续费订单对应的有效订阅
                .mockResolvedValueOnce({
                    id: 'sub-9',
                    expiresAt: at(50),
                });
            wireTransaction(ctx.prisma, tx);

            await ctx.service.markSuccess('refund-1');

            const call = tx.subscription.update.mock.calls[0][0];

            expect(call.where).toEqual({ id: 'sub-9' });
            expect(call.data.expiresAt).toEqual(at(30));
            expect(call.data.status).toBe(SubscriptionStatus.ACTIVE);
        });

        it('leaves subscriptions alone when none can be found', async () => {
            const ctx = createService();
            ctx.prisma.refund.findUnique.mockResolvedValue(makeRefund());
            const tx = makeTx();
            wireTransaction(ctx.prisma, tx);

            await ctx.service.markSuccess('refund-1');

            expect(tx.subscription.update).not.toHaveBeenCalled();
            expect(tx.order.update).toHaveBeenCalled();
        });

        it('restores paused lower-tier subscriptions after the reclaim', async () => {
            const ctx = createService();
            ctx.prisma.refund.findUnique.mockResolvedValue(makeRefund());
            const tx = makeTx();
            wireTransaction(ctx.prisma, tx);

            await ctx.service.markSuccess('refund-1');

            expect(
                ctx.effectivePlan.getEffectivePlanInTransaction,
            ).toHaveBeenCalledWith('org-1', tx);
        });

        it('notifies the buyer and the admins', async () => {
            const ctx = createService();
            ctx.prisma.refund.findUnique.mockResolvedValue(makeRefund());
            wireTransaction(ctx.prisma, makeTx());

            await ctx.service.markSuccess('refund-1');

            expect(ctx.notifications.publish).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: NotificationType.PAYMENT_REFUNDED,
                    eventKey: 'payment-refunded:refund-1',
                    recipients: ['user-1', 'owner'],
                }),
                expect.anything(),
            );
        });
    });

    describe('handleWechatRefundCallback', () => {
        it('settles the refund when WeChat reports SUCCESS', async () => {
            const ctx = createService();
            ctx.prisma.order.findUniqueOrThrow.mockResolvedValue(makeOrder());
            ctx.prisma.payment.findUnique.mockResolvedValue(payment);
            ctx.prisma.refund.findUnique.mockResolvedValue(makeRefund());
            ctx.provider.parseRefundCallback.mockResolvedValue({
                status: 'SUCCESS',
                outRefundNo: 'RF1',
                refundFee: 19933,
                totalFee: payment.amount,
                channelRefundId: 'wx-refund-1',
            });
            const tx = makeTx();
            wireTransaction(ctx.prisma, tx);

            const result = await ctx.service.handleWechatRefundCallback(
                '{}',
                'sig',
            );

            expect(result).toEqual({ handled: true });
            expect(tx.order.update).toHaveBeenCalled();
        });

        it('marks the refund FAILED when WeChat closed it', async () => {
            const ctx = createService();
            ctx.prisma.order.findUniqueOrThrow.mockResolvedValue(makeOrder());
            ctx.prisma.payment.findUnique.mockResolvedValue(payment);
            ctx.prisma.refund.findUnique.mockResolvedValue(makeRefund());
            ctx.provider.parseRefundCallback.mockResolvedValue({
                status: 'FAILED',
                outRefundNo: 'RF1',
                refundFee: 19933,
                totalFee: payment.amount,
                failureReason: 'CLOSED',
            });

            const result = await ctx.service.handleWechatRefundCallback(
                '{}',
                'sig',
            );

            expect(result).toEqual({ handled: true });
            expect(ctx.prisma.refund.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: RefundStatus.FAILED,
                    }),
                }),
            );
        });

        it('answers FAIL for an unknown refund number', async () => {
            const ctx = createService();
            ctx.prisma.order.findUniqueOrThrow.mockResolvedValue(makeOrder());
            ctx.prisma.payment.findUnique.mockResolvedValue(payment);
            ctx.prisma.refund.findUnique.mockResolvedValue(null);
            ctx.provider.parseRefundCallback.mockResolvedValue({
                status: 'SUCCESS',
                outRefundNo: 'RF-UNKNOWN',
            });

            const result = await ctx.service.handleWechatRefundCallback(
                '{}',
                'sig',
            );

            expect(result.handled).toBe(false);
            expect(result.message).toContain('not found');
        });
    });

    describe('retry', () => {
        it('resubmits a FAILED refund with the same refund number', async () => {
            const ctx = createService();
            const failed = makeRefund({ status: RefundStatus.FAILED });
            ctx.prisma.refund.findUnique.mockResolvedValue(failed);
            ctx.prisma.order.findUniqueOrThrow.mockResolvedValue(makeOrder());
            ctx.prisma.payment.findUnique.mockResolvedValue(payment);
            ctx.prisma.refund.update.mockResolvedValue({
                ...failed,
                status: RefundStatus.PENDING,
                failureReason: null,
            });
            ctx.prisma.refund.findUniqueOrThrow.mockResolvedValue(
                makeRefund({ status: RefundStatus.PROCESSING }),
            );
            ctx.provider.refund.mockResolvedValue({ status: 'PROCESSING' });

            await ctx.service.retry('refund-1');

            expect(ctx.prisma.refund.update).toHaveBeenCalledWith({
                where: { id: 'refund-1' },
                data: { status: RefundStatus.PENDING, failureReason: null },
            });
            expect(ctx.provider.refund).toHaveBeenCalledWith(
                expect.objectContaining({ outRefundNo: 'RF1' }),
            );
        });

        it('refuses to retry a refund that is not FAILED', async () => {
            const ctx = createService();
            ctx.prisma.refund.findUnique.mockResolvedValue(
                makeRefund({ status: RefundStatus.SUCCESS }),
            );

            await expect(ctx.service.retry('refund-1')).rejects.toThrow(
                'Only a failed refund can be retried',
            );
        });
    });

    describe('markClosed', () => {
        it('closes a pending refund with a reason', async () => {
            const ctx = createService();
            ctx.prisma.refund.findUniqueOrThrow.mockResolvedValue(
                makeRefund({ status: RefundStatus.CLOSED }),
            );

            await ctx.service.markClosed('refund-1', 'customer withdrew');

            expect(ctx.prisma.refund.updateMany).toHaveBeenCalledWith({
                where: {
                    id: 'refund-1',
                    status: {
                        in: [
                            RefundStatus.PENDING,
                            RefundStatus.PROCESSING,
                            RefundStatus.FAILED,
                        ],
                    },
                },
                data: {
                    status: RefundStatus.CLOSED,
                    failureReason: 'customer withdrew',
                },
            });
        });
    });

    describe('syncFromChannel', () => {
        it('settles when the channel finally reports SUCCESS', async () => {
            const ctx = createService();
            const refund = makeRefund({ status: RefundStatus.PROCESSING });
            ctx.prisma.refund.findUnique.mockResolvedValue(refund);
            ctx.prisma.order.findUniqueOrThrow.mockResolvedValue(makeOrder());
            ctx.provider.queryRefund.mockResolvedValue({
                status: 'SUCCESS',
                channelRefundId: 'wx-refund-1',
            });
            const tx = makeTx();
            wireTransaction(ctx.prisma, tx);

            await ctx.service.syncFromChannel('refund-1');

            expect(ctx.provider.queryRefund).toHaveBeenCalledWith({
                refundNo: 'RF1',
                outTradeNo: 'BW1',
                orderId: 'order-1',
            });
            expect(tx.order.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: OrderStatus.REFUNDED,
                    }),
                }),
            );
        });

        it('does nothing for a refund that already reached a final state', async () => {
            const ctx = createService();
            ctx.prisma.refund.findUnique.mockResolvedValue(
                makeRefund({ status: RefundStatus.SUCCESS }),
            );

            await ctx.service.syncFromChannel('refund-1');

            expect(ctx.provider.queryRefund).not.toHaveBeenCalled();
        });
    });
});
