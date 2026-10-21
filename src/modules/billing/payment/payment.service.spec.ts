import { PaymentChannel, PaymentStatus } from '../../../generated/prisma/enums';
import { AlipayPayMethod } from '../../../infra/alipay';
import { PaymentService } from './payment.service';
import type { PrismaService } from '../../../infra/database/prisma.service';
import type { PaymentProviderFactory } from './payment-provider.factory';

const order = {
    id: 'order-1',
    orderNo: 'BWABC123',
    organizationId: 'org-1',
    planId: 'plan-pro',
    userId: 'user-1',
    amount: 2900,
    durationDays: 30,
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
};

const payParams = {
    timeStamp: '1',
    nonceStr: 'nonce',
    package: 'prepay_id=mock',
    signType: 'RSA',
    paySign: 'sign',
};

function createService() {
    const prisma = {
        order: { findUnique: jest.fn() },
        membership: { findUnique: jest.fn() },
        payment: {
            upsert: jest.fn(),
            findFirst: jest.fn(),
            findUnique: jest.fn(),
        },
        $transaction: jest.fn(),
    };
    const provider = {
        createPayment: jest.fn(),
        verifyCallback: jest.fn(),
    };
    const paymentProviderFactory = {
        get: jest.fn().mockReturnValue(provider),
    };
    const notifications = {
        publish: jest.fn().mockResolvedValue(undefined),
        organizationRecipients: jest.fn().mockResolvedValue(['owner', 'admin']),
    };

    const service = new PaymentService(
        prisma as unknown as PrismaService,
        paymentProviderFactory as unknown as PaymentProviderFactory,
        notifications as never,
    );

    return { service, prisma, provider, paymentProviderFactory, notifications };
}

describe('PaymentService', () => {
    describe('createPayment', () => {
        it('selects the provider from the factory and upserts the payment', async () => {
            const { service, prisma, provider, paymentProviderFactory } =
                createService();
            prisma.order.findUnique.mockResolvedValue(order);
            prisma.membership.findUnique.mockResolvedValue({ id: 'member-1' });
            provider.createPayment.mockResolvedValue(payParams);
            prisma.payment.upsert.mockResolvedValue({ id: 'payment-1' });

            const result = await service.createPayment('order-1', 'user-1', {
                openid: 'o_xxx',
            });

            expect(paymentProviderFactory.get).toHaveBeenCalledWith('WECHAT');
            expect(provider.createPayment).toHaveBeenCalledWith({
                outTradeNo: 'BWABC123',
                totalFee: 2900,
                payerId: 'o_xxx',
                body: 'Beaconix plan order BWABC123',
            });
            expect(result).toEqual(payParams);
            expect(prisma.payment.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { orderId: 'order-1' },
                    create: expect.objectContaining({
                        channel: 'WECHAT',
                        amount: 2900,
                    }),
                }),
            );
        });

        it('refuses to switch channels once a payment has succeeded', async () => {
            const { service, prisma, paymentProviderFactory } = createService();
            prisma.order.findUnique.mockResolvedValue(order);
            prisma.membership.findUnique.mockResolvedValue({ id: 'member-1' });
            prisma.payment.findUnique.mockResolvedValue({
                channel: PaymentChannel.WECHAT,
                status: PaymentStatus.SUCCESS,
            });

            await expect(
                service.createPayment('order-1', 'user-1', {
                    openid: 'o_xxx',
                    // ALIPAY 会随后续迁移加入枚举，这里先按渠道断言行为
                    channel: 'ALIPAY',
                }),
            ).rejects.toThrow('Order already paid via WECHAT');

            // 覆盖记录会让原渠道的回调按 channel 查不到它，必须在调 provider 之前拦下
            expect(paymentProviderFactory.get).not.toHaveBeenCalled();
            expect(prisma.payment.upsert).not.toHaveBeenCalled();
        });

        it('refuses a repeat payment on the channel that already succeeded', async () => {
            const { service, prisma } = createService();
            prisma.order.findUnique.mockResolvedValue(order);
            prisma.membership.findUnique.mockResolvedValue({ id: 'member-1' });
            prisma.payment.findUnique.mockResolvedValue({
                channel: PaymentChannel.WECHAT,
                status: PaymentStatus.SUCCESS,
            });

            await expect(
                service.createPayment('order-1', 'user-1', { openid: 'o_xxx' }),
            ).rejects.toThrow('Order is already paid');
        });

        it('allows switching channels while the previous payment is pending', async () => {
            const { service, prisma, provider } = createService();
            prisma.order.findUnique.mockResolvedValue(order);
            prisma.membership.findUnique.mockResolvedValue({ id: 'member-1' });
            prisma.payment.findUnique.mockResolvedValue({
                channel: PaymentChannel.WECHAT,
                status: PaymentStatus.PENDING,
            });
            provider.createPayment.mockResolvedValue({
                payUrl: 'https://openapi.alipay.com/gateway.do?sign=...',
            });
            prisma.payment.upsert.mockResolvedValue({ id: 'payment-1' });

            await service.createPayment('order-1', 'user-1', {
                openid: 'o_xxx',
                channel: 'ALIPAY',
            });

            expect(prisma.payment.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { orderId: 'order-1' },
                    update: expect.objectContaining({ channel: 'ALIPAY' }),
                }),
            );
        });
    });

    describe('handleWechatCallback', () => {
        it('publishes a renewal rather than activation for an existing subscription', async () => {
            const { service, prisma, provider, notifications } =
                createService();
            provider.verifyCallback.mockResolvedValue({
                out_trade_no: order.orderNo,
                transaction_id: 'transaction',
                trade_state: 'SUCCESS',
            });
            prisma.payment.findFirst.mockResolvedValue({
                id: 'payment-1',
                orderId: order.id,
                status: 'PENDING',
                order,
            });
            const expiresAt = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
            const tx = {
                $queryRaw: jest.fn(),
                payment: {
                    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                },
                order: { update: jest.fn() },
                subscription: {
                    findFirst: jest
                        .fn()
                        .mockResolvedValue({ id: 'sub-1', expiresAt }),
                    update: jest.fn(),
                    create: jest.fn(),
                },
                plan: {
                    findUniqueOrThrow: jest
                        .fn()
                        .mockResolvedValue({ sortOrder: 2 }),
                },
            };
            prisma.$transaction.mockImplementation((callback) => callback(tx));
            await service.handleWechatCallback('{}', 'signature');
            expect(tx.subscription.create).not.toHaveBeenCalled();
            // 续费订单的快照是「原到期时刻 → 延长后的到期时刻」。
            expect(tx.order.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: {
                        serviceStartsAt: expiresAt,
                        serviceEndsAt: new Date(
                            expiresAt.getTime() +
                                order.durationDays * 24 * 60 * 60 * 1000,
                        ),
                    },
                }),
            );
            expect(
                notifications.publish.mock.calls.map(([event]) => event.type),
            ).toEqual(['PAYMENT_SUCCEEDED', 'SUBSCRIPTION_RENEWED']);
            expect(notifications.publish.mock.calls[1][0].meta.expiresAt).toBe(
                new Date(
                    expiresAt.getTime() +
                        order.durationDays * 24 * 60 * 60 * 1000,
                ).toISOString(),
            );
        });

        it('fails callback persistence when the transactional notification cannot be stored', async () => {
            const { service, prisma, provider, notifications } =
                createService();
            provider.verifyCallback.mockResolvedValue({
                out_trade_no: order.orderNo,
                transaction_id: 'transaction',
                trade_state: 'SUCCESS',
            });
            prisma.payment.findFirst.mockResolvedValue({
                id: 'payment-1',
                orderId: order.id,
                status: 'PENDING',
                order,
            });
            const tx = {
                $queryRaw: jest.fn(),
                payment: {
                    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                },
                order: { update: jest.fn() },
                subscription: {
                    findFirst: jest.fn().mockResolvedValue(null),
                    create: jest.fn().mockResolvedValue({ id: 'sub-1' }),
                },
                plan: {
                    findUniqueOrThrow: jest
                        .fn()
                        .mockResolvedValue({ sortOrder: 2 }),
                },
            };
            prisma.$transaction.mockImplementation((callback) => callback(tx));
            notifications.publish.mockRejectedValue(
                new Error('outbox unavailable'),
            );
            await expect(
                service.handleWechatCallback('{}', 'signature'),
            ).rejects.toThrow('outbox unavailable');
        });

        it('activates the subscription and marks order/payment as paid', async () => {
            const { service, prisma, provider, notifications } =
                createService();
            provider.verifyCallback.mockResolvedValue({
                out_trade_no: 'BWABC123',
                transaction_id: 'wx-tx-1',
                trade_state: 'SUCCESS',
            });
            prisma.payment.findFirst.mockResolvedValue({
                id: 'payment-1',
                orderId: 'order-1',
                status: 'PENDING',
                order,
            });

            const tx = {
                $queryRaw: jest.fn(),
                payment: {
                    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                },
                order: { update: jest.fn() },
                subscription: {
                    findFirst: jest.fn().mockResolvedValue(null),
                    create: jest.fn().mockResolvedValue({ id: 'sub-1' }),
                    update: jest.fn(),
                },
                plan: {
                    findUniqueOrThrow: jest
                        .fn()
                        .mockResolvedValue({ sortOrder: 2 }),
                },
            };
            prisma.$transaction.mockImplementation((fn) => fn(tx));

            const result = await service.handleWechatCallback(
                JSON.stringify({}),
                'signature',
            );

            expect(result).toEqual({ code: 'SUCCESS', message: '成功' });
            expect(tx.payment.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        id: 'payment-1',
                        status: { not: 'SUCCESS' },
                    }),
                    data: expect.objectContaining({
                        status: 'SUCCESS',
                        transactionId: 'wx-tx-1',
                    }),
                }),
            );
            expect(tx.order.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: 'PAID' }),
                }),
            );
            // 结算必须写下服务期快照：退款折算与订阅回收都依赖它。
            const snapshotCall = tx.order.update.mock.calls.find(
                ([args]) => args?.data?.serviceStartsAt,
            )?.[0];

            expect(snapshotCall).toBeDefined();
            expect(
                snapshotCall.data.serviceEndsAt.getTime() -
                    snapshotCall.data.serviceStartsAt.getTime(),
            ).toBe(order.durationDays * 24 * 60 * 60 * 1000);
            expect(tx.subscription.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        organizationId: 'org-1',
                        planId: 'plan-pro',
                        status: 'ACTIVE',
                    }),
                }),
            );
            expect(notifications.publish).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'PAYMENT_SUCCEEDED',
                    recipients: ['user-1', 'owner', 'admin'],
                    eventKey: 'payment-succeeded:payment-1',
                }),
                tx,
            );
            expect(notifications.publish).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'SUBSCRIPTION_ACTIVATED',
                    resourceId: 'sub-1',
                }),
                tx,
            );
        });

        it('freezes lower-tier subscriptions when upgrading to a higher plan', async () => {
            const { service, prisma, provider } = createService();
            provider.verifyCallback.mockResolvedValue({
                out_trade_no: order.orderNo,
                transaction_id: 'wx-tx-upgrade',
                trade_state: 'SUCCESS',
            });
            prisma.payment.findFirst.mockResolvedValue({
                id: 'payment-1',
                orderId: order.id,
                status: 'PENDING',
                order: { ...order, planId: 'plan-team', durationDays: 365 },
            });

            const proExpiry = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000);
            const tx = {
                $queryRaw: jest.fn(),
                payment: {
                    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                },
                order: { update: jest.fn() },
                plan: {
                    findUniqueOrThrow: jest
                        .fn()
                        .mockResolvedValue({ sortOrder: 3 }),
                },
                subscription: {
                    // 1st: same-plan lookup misses; 2nd: the effective plan is PRO.
                    findFirst: jest
                        .fn()
                        .mockResolvedValueOnce(null)
                        .mockResolvedValueOnce({
                            id: 'sub-pro',
                            expiresAt: proExpiry,
                            plan: { sortOrder: 2 },
                        }),
                    findMany: jest
                        .fn()
                        .mockResolvedValue([
                            { id: 'sub-pro', expiresAt: proExpiry },
                        ]),
                    update: jest.fn(),
                    create: jest.fn().mockResolvedValue({ id: 'sub-team' }),
                },
            };
            prisma.$transaction.mockImplementation((fn) => fn(tx));

            await service.handleWechatCallback('{}', 'signature');

            expect(tx.subscription.update).toHaveBeenCalledWith({
                where: { id: 'sub-pro' },
                data: expect.objectContaining({
                    status: 'PAUSED',
                    pausedRemainingDays: 100,
                }),
            });
            expect(tx.subscription.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        planId: 'plan-team',
                        status: 'ACTIVE',
                    }),
                }),
            );
        });

        it('queues a lower-tier purchase behind the current plan', async () => {
            const { service, prisma, provider } = createService();
            provider.verifyCallback.mockResolvedValue({
                out_trade_no: order.orderNo,
                transaction_id: 'wx-tx-downgrade',
                trade_state: 'SUCCESS',
            });
            prisma.payment.findFirst.mockResolvedValue({
                id: 'payment-1',
                orderId: order.id,
                status: 'PENDING',
                order,
            });

            const teamExpiry = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
            const tx = {
                $queryRaw: jest.fn(),
                payment: {
                    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                },
                order: { update: jest.fn() },
                plan: {
                    findUniqueOrThrow: jest
                        .fn()
                        .mockResolvedValue({ sortOrder: 2 }),
                },
                subscription: {
                    findFirst: jest
                        .fn()
                        .mockResolvedValueOnce(null)
                        .mockResolvedValueOnce({
                            id: 'sub-team',
                            expiresAt: teamExpiry,
                            plan: { sortOrder: 3 },
                        }),
                    findMany: jest.fn(),
                    update: jest.fn(),
                    create: jest.fn().mockResolvedValue({ id: 'sub-pro' }),
                },
            };
            prisma.$transaction.mockImplementation((fn) => fn(tx));

            await service.handleWechatCallback('{}', 'signature');

            // Nothing is frozen; the new plan simply waits for TEAM to lapse.
            expect(tx.subscription.findMany).not.toHaveBeenCalled();
            expect(tx.subscription.update).not.toHaveBeenCalled();
            expect(tx.subscription.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        startsAt: teamExpiry,
                        expiresAt: new Date(
                            teamExpiry.getTime() +
                                order.durationDays * 24 * 60 * 60 * 1000,
                        ),
                    }),
                }),
            );
        });

        it('is idempotent when the payment is already SUCCESS', async () => {
            const { service, prisma, provider, notifications } =
                createService();
            provider.verifyCallback.mockResolvedValue({
                out_trade_no: 'BWABC123',
                transaction_id: 'wx-tx-1',
                trade_state: 'SUCCESS',
            });
            prisma.payment.findFirst.mockResolvedValue({
                id: 'payment-1',
                orderId: 'order-1',
                status: 'SUCCESS',
                order,
            });

            const result = await service.handleWechatCallback(
                '{}',
                'signature',
            );

            expect(result).toEqual({ code: 'SUCCESS', message: '成功' });
            expect(prisma.$transaction).not.toHaveBeenCalled();
            expect(notifications.publish).not.toHaveBeenCalled();
        });

        it('skips order/subscription work when a concurrent callback settled the payment', async () => {
            const { service, prisma, provider, notifications } =
                createService();
            provider.verifyCallback.mockResolvedValue({
                out_trade_no: 'BWABC123',
                transaction_id: 'wx-tx-1',
                trade_state: 'SUCCESS',
            });
            prisma.payment.findFirst.mockResolvedValue({
                id: 'payment-1',
                orderId: 'order-1',
                status: 'PENDING',
                order,
            });

            const tx = {
                payment: {
                    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                },
                order: { update: jest.fn() },
                subscription: {
                    findFirst: jest.fn(),
                    create: jest.fn(),
                    update: jest.fn(),
                },
            };
            prisma.$transaction.mockImplementation((fn) => fn(tx));

            const result = await service.handleWechatCallback(
                '{}',
                'signature',
            );

            expect(result).toEqual({ code: 'SUCCESS', message: '成功' });
            expect(tx.payment.updateMany).toHaveBeenCalled();
            expect(tx.order.update).not.toHaveBeenCalled();
            expect(tx.subscription.findFirst).not.toHaveBeenCalled();
            expect(tx.subscription.create).not.toHaveBeenCalled();
            expect(notifications.publish).not.toHaveBeenCalled();
        });

        it('normalises an empty transaction_id to null', async () => {
            const { service, prisma, provider } = createService();
            provider.verifyCallback.mockResolvedValue({
                out_trade_no: 'BWABC123',
                transaction_id: '',
                trade_state: 'SUCCESS',
            });
            prisma.payment.findFirst.mockResolvedValue({
                id: 'payment-1',
                orderId: 'order-1',
                status: 'PENDING',
                order,
            });

            const tx = {
                $queryRaw: jest.fn(),
                payment: {
                    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                },
                order: { update: jest.fn() },
                subscription: {
                    findFirst: jest.fn().mockResolvedValue(null),
                    create: jest.fn().mockResolvedValue({ id: 'sub-1' }),
                    update: jest.fn(),
                },
                plan: {
                    findUniqueOrThrow: jest
                        .fn()
                        .mockResolvedValue({ sortOrder: 2 }),
                },
            };
            prisma.$transaction.mockImplementation((fn) => fn(tx));

            const result = await service.handleWechatCallback(
                '{}',
                'signature',
            );

            expect(result).toEqual({ code: 'SUCCESS', message: '成功' });
            expect(tx.payment.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: 'SUCCESS',
                        transactionId: null,
                    }),
                }),
            );
        });
    });

    describe('createPayment (ALIPAY)', () => {
        it('does not require openid and forwards the payMethod', async () => {
            const { service, prisma, provider, paymentProviderFactory } =
                createService();
            prisma.order.findUnique.mockResolvedValue(order);
            prisma.membership.findUnique.mockResolvedValue({ id: 'member-1' });
            provider.createPayment.mockResolvedValue({
                payUrl: 'https://openapi.alipay.com/gateway.do?sign=x',
                outTradeNo: order.orderNo,
            });
            prisma.payment.upsert.mockResolvedValue({ id: 'payment-1' });

            const result = await service.createPayment('order-1', 'user-1', {
                channel: PaymentChannel.ALIPAY,
                payMethod: AlipayPayMethod.PAGE,
            });

            expect(paymentProviderFactory.get).toHaveBeenCalledWith('ALIPAY');
            expect(provider.createPayment).toHaveBeenCalledWith({
                outTradeNo: 'BWABC123',
                totalFee: 2900,
                // 支付宝渠道没有付款人身份
                payerId: undefined,
                payMethod: AlipayPayMethod.PAGE,
                body: 'Beaconix plan order BWABC123',
            });
            expect(result).toEqual({
                payUrl: 'https://openapi.alipay.com/gateway.do?sign=x',
                outTradeNo: 'BWABC123',
            });
        });

        it('stores the cashier URL in prepayId because Alipay has no prepay_id', async () => {
            const { service, prisma, provider } = createService();
            prisma.order.findUnique.mockResolvedValue(order);
            prisma.membership.findUnique.mockResolvedValue({ id: 'member-1' });
            provider.createPayment.mockResolvedValue({
                payUrl: 'https://openapi.alipay.com/gateway.do?sign=x',
                outTradeNo: order.orderNo,
            });
            prisma.payment.upsert.mockResolvedValue({ id: 'payment-1' });

            await service.createPayment('order-1', 'user-1', {
                channel: PaymentChannel.ALIPAY,
            });

            expect(prisma.payment.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    create: expect.objectContaining({
                        channel: 'ALIPAY',
                        prepayId:
                            'https://openapi.alipay.com/gateway.do?sign=x',
                    }),
                }),
            );
        });

        it('still requires openid for the WeChat JSAPI channel', async () => {
            const { service, prisma, provider } = createService();
            prisma.order.findUnique.mockResolvedValue(order);
            prisma.membership.findUnique.mockResolvedValue({ id: 'member-1' });

            await expect(
                service.createPayment('order-1', 'user-1', {}),
            ).rejects.toThrow(/openid is required/);
            expect(provider.createPayment).not.toHaveBeenCalled();
        });
    });

    describe('handleAlipayCallback', () => {
        it('settles through the ALIPAY provider and looks the payment up by channel', async () => {
            const { service, prisma, provider, paymentProviderFactory } =
                createService();
            provider.verifyCallback.mockResolvedValue({
                out_trade_no: 'BWABC123',
                transaction_id: '2026102122001400000000000001',
                trade_state: 'SUCCESS',
                trade_status: 'TRADE_SUCCESS',
            });
            prisma.payment.findFirst.mockResolvedValue({
                id: 'payment-1',
                orderId: 'order-1',
                status: 'SUCCESS',
                order,
            });

            const rawBody =
                'out_trade_no=BWABC123&trade_status=TRADE_SUCCESS&sign=x';
            const result = await service.handleAlipayCallback(rawBody);

            expect(result).toEqual({ code: 'SUCCESS', message: '成功' });
            expect(paymentProviderFactory.get).toHaveBeenCalledWith('ALIPAY');
            expect(provider.verifyCallback).toHaveBeenCalledWith(
                rawBody,
                '',
                undefined,
            );
            expect(prisma.payment.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        channel: 'ALIPAY',
                        order: { orderNo: 'BWABC123' },
                    },
                }),
            );
        });

        it('refuses a non-success trade state without touching the payment', async () => {
            const { service, prisma, provider } = createService();
            provider.verifyCallback.mockResolvedValue({
                out_trade_no: 'BWABC123',
                transaction_id: '',
                trade_state: 'WAIT_BUYER_PAY',
                trade_status: 'WAIT_BUYER_PAY',
            });

            const result = await service.handleAlipayCallback(
                'out_trade_no=BWABC123&trade_status=WAIT_BUYER_PAY',
            );

            expect(result.code).toBe('FAIL');
            expect(prisma.payment.findFirst).not.toHaveBeenCalled();
            expect(prisma.$transaction).not.toHaveBeenCalled();
        });
    });
});
