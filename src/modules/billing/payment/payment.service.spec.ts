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
                body: 'Beacon plan order BWABC123',
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
            };
            prisma.$transaction.mockImplementation((callback) => callback(tx));
            await service.handleWechatCallback('{}', 'signature');
            expect(tx.subscription.create).not.toHaveBeenCalled();
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
});
