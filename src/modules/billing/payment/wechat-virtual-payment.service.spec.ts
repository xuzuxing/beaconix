import { createHash } from 'node:crypto';
import { PaymentChannel, PaymentStatus } from '../../../generated/prisma/enums';
import type { PrismaService } from '../../../infra/database/prisma.service';
import type { MiniprogramClient } from '../../../infra/wechat/miniprogram';
import type { WechatRuntimeConfigService } from '../../../infra/wechat';
import type { WechatVirtualPayClient } from '../../../infra/wechat';
import type { NotificationsService } from '../../notifications/notifications.service';
import type { RefundService } from '../refund/refund.service';
import type { PaymentService } from './payment.service';
import { WechatVirtualPaymentService } from './wechat-virtual-payment.service';

const order = {
    id: 'order-1',
    orderNo: 'BWMB3KXABC123',
    organizationId: 'org-1',
    planId: 'plan-pro',
    userId: 'user-1',
    amount: 2900,
    refundedAmount: 0,
    durationDays: 30,
    termId: 'term-1',
    cycle: 'MONTHLY',
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    paidAt: null,
    cancelledAt: null,
    currency: 'CNY',
    createdAt: new Date(),
    updatedAt: new Date(),
};

const deliverXml = (overrides?: {
    outTradeNo?: string;
    actualPrice?: number;
    wxOrderId?: string;
}) => `<xml>
  <Event><![CDATA[xpay_goods_deliver_notify]]></Event>
  <OpenId><![CDATA[o_user_openid]]></OpenId>
  <OutTradeNo><![CDATA[${overrides?.outTradeNo ?? 'VABC123456789'}]]></OutTradeNo>
  <Env>0</Env>
  <WeChatPayInfo>
    <MchOrderNo><![CDATA[${overrides?.wxOrderId ?? 'wx_order_1'}]]></MchOrderNo>
    <TransactionId><![CDATA[4200001]]></TransactionId>
    <PaidTime>1700000100</PaidTime>
  </WeChatPayInfo>
  <GoodsInfo>
    <ProductId><![CDATA[beacon_pro_month]]></ProductId>
    <Quantity>1</Quantity>
    <OrigPrice>2900</OrigPrice>
    <ActualPrice>${overrides?.actualPrice ?? 2900}</ActualPrice>
    <Attach><![CDATA[BWMB3KXABC123]]></Attach>
  </GoodsInfo>
</xml>`;

const deliverJson = (overrides?: {
    outTradeNo?: string;
    actualPrice?: number;
    wxOrderId?: string;
}) =>
    JSON.stringify({
        ToUserName: 'gh_000000000000',
        FromUserName: 'o_official_openid',
        CreateTime: 1761000000,
        MsgType: 'event',
        Event: 'xpay_goods_deliver_notify',
        OpenId: 'o_user_openid',
        OutTradeNo: overrides?.outTradeNo ?? 'VABC123456789',
        Env: 0,
        WeChatPayInfo: {
            MchOrderNo: overrides?.wxOrderId ?? 'wx_order_1',
            TransactionId: '4200001',
            PaidTime: 1761000100,
        },
        GoodsInfo: {
            ProductId: 'beacon_pro_month',
            Quantity: 1,
            OrigPrice: 2900,
            ActualPrice: overrides?.actualPrice ?? 2900,
            Attach: 'BWMB3KXABC123',
        },
    });

function createHarness(options?: {
    attempt?: Record<string, unknown> | null;
    mock?: boolean;
    queryStatus?: number;
}) {
    const tx = {
        order: {
            update: jest.fn().mockResolvedValue(order),
            findUniqueOrThrow: jest.fn().mockResolvedValue(order),
        },
        payment: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: 'payment-1' }),
            update: jest.fn().mockResolvedValue({ id: 'payment-1' }),
        },
        paymentAttempt: {
            create: jest.fn().mockResolvedValue({ id: 'attempt-new' }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            update: jest.fn(),
        },
        subscription: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: 'sub-1' }),
            update: jest.fn(),
        },
        plan: {
            findUniqueOrThrow: jest.fn().mockResolvedValue({ sortOrder: 1 }),
        },
        refund: {
            create: jest.fn(),
            findFirst: jest.fn().mockResolvedValue(null),
            update: jest.fn(),
        },
        subscriptionEntitlement: { create: jest.fn() },
        $queryRaw: jest.fn().mockResolvedValue([]),
    };

    const attempt =
        options?.attempt === undefined
            ? {
                  id: 'attempt-1',
                  orderId: order.id,
                  channel: PaymentChannel.WECHAT_VIRTUAL,
                  outTradeNo: 'VABC123456789',
                  openid: 'o_user_openid',
                  productId: 'beacon_pro_month',
                  amount: 2900,
                  env: 0,
                  status: 'PENDING',
                  wxOrderId: null,
                  paidAt: null,
                  rawNotify: null,
                  order,
              }
            : options.attempt;

    const prisma = {
        userIdentity: {
            findFirst: jest.fn().mockResolvedValue({
                openid: 'o_user_openid',
            }),
        },
        planTerm: {
            findUnique: jest.fn().mockResolvedValue({
                id: 'term-1',
                price: 2900,
                wechatProductId: 'beacon_pro_month',
            }),
        },
        paymentAttempt: {
            create: jest.fn().mockResolvedValue({ id: 'attempt-new' }),
            findUnique: jest.fn().mockResolvedValue(attempt),
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue({
                outTradeNo: 'VABC123456789',
                openid: 'o_user_openid',
            }),
        },
        payment: {
            findUnique: jest.fn().mockResolvedValue({
                channel: PaymentChannel.WECHAT_VIRTUAL,
                outTradeNo: 'VABC123456789',
                status: PaymentStatus.SUCCESS,
            }),
        },
        refund: { findFirst: jest.fn().mockResolvedValue(null) },
        order: {
            findFirst: jest.fn().mockResolvedValue(order),
            update: jest.fn(),
        },
        $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) =>
            Promise.resolve().then(() => fn(tx)),
        ),
    };

    const paymentService = {
        ensureOrderPayable: jest.fn().mockResolvedValue(order),
        assertChannelSwitchable: jest.fn().mockResolvedValue(undefined),
    };
    const notifications = {
        publish: jest.fn().mockResolvedValue(undefined),
        organizationRecipients: jest.fn().mockResolvedValue(['admin-1']),
    };
    const client = {
        buildPayData: jest.fn().mockResolvedValue({
            signData: '{"offerId":"1"}',
            mode: 'short_series_goods',
            paySig: 'pay-sig',
            signature: 'signature',
        }),
        credentials: jest.fn().mockResolvedValue({
            offerId: '1',
            appKey: 'k',
            env: 0,
            mock: false,
        }),
        isMock: jest.fn().mockResolvedValue(options?.mock ?? false),
        queryOrder: jest.fn().mockResolvedValue({
            status: options?.queryStatus ?? 2,
            wxOrderId: 'wx_order_1',
            paidFee: 2900,
            paidTime: 1700000100,
        }),
        refundOrder: jest.fn().mockResolvedValue(undefined),
    };
    const miniprogramClient = {
        code2Session: jest.fn().mockResolvedValue({
            openid: 'o_user_openid',
            sessionKey: 'session-key',
        }),
    };
    const runtimeConfig = {
        miniprogram: jest
            .fn()
            .mockResolvedValue({ appId: 'wx-app', appSecret: 'secret' }),
        virtualPay: jest.fn().mockResolvedValue({
            offerId: '1',
            appKey: 'k',
            sandboxAppKey: '',
            env: 0,
            pushToken: '',
            pushAesKey: '',
            mock: options?.mock ?? false,
        }),
    };

    const refunds = {
        markSuccess: jest.fn().mockResolvedValue({ id: 'refund-1' }),
    };

    const service = new WechatVirtualPaymentService(
        prisma as unknown as PrismaService,
        paymentService as unknown as PaymentService,
        notifications as unknown as NotificationsService,
        client as unknown as WechatVirtualPayClient,
        miniprogramClient as unknown as MiniprogramClient,
        runtimeConfig as unknown as WechatRuntimeConfigService,
        refunds as unknown as RefundService,
        {
            getEffectivePlanInTransaction: jest.fn().mockResolvedValue(null),
        } as never,
    );

    return {
        service,
        prisma,
        tx,
        client,
        paymentService,
        notifications,
        miniprogramClient,
        runtimeConfig,
        refunds,
    };
}

describe('WechatVirtualPaymentService', () => {
    it('rechecks cancellation after session exchange before issuing payData', async () => {
        const h = createHarness();
        h.miniprogramClient.code2Session.mockImplementation(() =>
            Promise.resolve().then(() => {
                h.tx.order.findUniqueOrThrow.mockResolvedValue({
                    ...order,
                    status: 'CANCELLED',
                });
                return { openid: 'o_user_openid', sessionKey: 's' };
            }),
        );
        await expect(
            h.service.createPayment(order.id, 'user-1', { code: 'fresh' }),
        ).rejects.toThrow('no longer payable');
        expect(h.tx.paymentAttempt.create).not.toHaveBeenCalled();
    });

    it.each(['CANCELLED', 'REFUNDED'])(
        'retains late paid funds on a %s order without issuing entitlement',
        async (status) => {
            const h = createHarness();
            h.tx.order.findUniqueOrThrow.mockResolvedValue({
                ...order,
                status,
            });
            const result = await h.service.handleNotify({
                rawBody: deliverXml(),
                query: {},
            });
            expect(result.reply).toContain('<ErrCode>0</ErrCode>');
            expect(h.tx.paymentAttempt.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: 'PAID' }),
                }),
            );
            expect(h.tx.order.update).not.toHaveBeenCalled();
            expect(h.notifications.publish).toHaveBeenCalledWith(
                expect.objectContaining({
                    email: true,
                    eventKey: expect.stringContaining('payment-duplicate:'),
                }),
                expect.anything(),
            );
        },
    );

    it('locates the winning virtual attempt by merchant number, with a transaction fallback for old payments', async () => {
        const h = createHarness();
        await h.service.queryRefund({
            orderId: order.id,
            outTradeNo: order.orderNo,
            refundNo: 'RF1',
        });
        expect(h.prisma.paymentAttempt.findFirst).toHaveBeenLastCalledWith(
            expect.objectContaining({
                where: {
                    orderId: order.id,
                    channel: PaymentChannel.WECHAT_VIRTUAL,
                    status: 'PAID',
                    outTradeNo: 'VABC123456789',
                },
            }),
        );
        h.prisma.payment.findUnique.mockResolvedValue({
            channel: PaymentChannel.WECHAT_VIRTUAL,
            outTradeNo: null,
            transactionId: 'legacy-tx',
        });
        await h.service.queryRefund({
            orderId: order.id,
            outTradeNo: order.orderNo,
            refundNo: 'RF1',
        });
        expect(h.prisma.paymentAttempt.findFirst).toHaveBeenLastCalledWith(
            expect.objectContaining({
                where: {
                    orderId: order.id,
                    channel: PaymentChannel.WECHAT_VIRTUAL,
                    status: 'PAID',
                    wxOrderId: 'legacy-tx',
                },
            }),
        );
    });

    it.each([
        { channel: PaymentChannel.WECHAT, outTradeNo: 'P1' },
        { channel: PaymentChannel.WECHAT_VIRTUAL },
    ])(
        'refuses to guess a refundable virtual attempt from %s',
        async (payment) => {
            const h = createHarness();
            h.prisma.payment.findUnique.mockResolvedValue(payment);
            expect(
                (
                    await h.service.queryRefund({
                        orderId: order.id,
                        outTradeNo: order.orderNo,
                        refundNo: 'RF1',
                    })
                ).status,
            ).toBe('PROCESSING');
            expect(h.prisma.paymentAttempt.findFirst).not.toHaveBeenCalled();
            expect(h.client.queryOrder).not.toHaveBeenCalled();
        },
    );

    it('does not apply a refund of a duplicate virtual payment to the winning ordinary payment', async () => {
        const h = createHarness();
        h.prisma.payment.findUnique.mockResolvedValue({
            channel: PaymentChannel.ALIPAY,
            status: 'SUCCESS',
            outTradeNo: 'P_WINNER',
        });
        await h.service.handleNotify({
            rawBody: JSON.stringify({
                Event: 'xpay_refund_notify',
                OutTradeNo: 'VABC123456789',
                WeChatPayInfo: { RefundFee: 2900 },
            }),
            query: {},
        });
        expect(h.tx.order.update).not.toHaveBeenCalled();
        expect(h.refunds.markSuccess).not.toHaveBeenCalled();
    });
    describe('verifyPushUrl', () => {
        it('echoes echostr back when no pushToken is configured', async () => {
            const harness = createHarness();

            const result = await harness.service.verifyPushUrl({
                query: { echostr: 'echo-123' },
            });

            expect(result).toEqual({ ok: true, body: 'echo-123' });
        });

        it('requires a valid signature once pushToken is configured', async () => {
            const harness = createHarness();
            harness.runtimeConfig.virtualPay.mockResolvedValue({
                offerId: '1',
                appKey: 'k',
                sandboxAppKey: '',
                env: 0,
                pushToken: 'push-token',
                pushAesKey: '',
                mock: false,
            });

            const timestamp = '1792582808';
            const nonce = '173387765';
            const signature = createHash('sha1')
                .update(['push-token', timestamp, nonce].sort().join(''))
                .digest('hex');

            await expect(
                harness.service.verifyPushUrl({
                    query: { echostr: 'e', timestamp, nonce, signature },
                }),
            ).resolves.toEqual({ ok: true, body: 'e' });

            // 缺 signature / signature 不对都必须拒绝，否则任何人都能挂推送地址
            await expect(
                harness.service.verifyPushUrl({
                    query: { echostr: 'e', timestamp, nonce },
                }),
            ).resolves.toEqual({ ok: false, body: 'invalid signature' });
        });
    });

    describe('createPayment', () => {
        it('returns signed payData and records a payment attempt', async () => {
            const harness = createHarness();

            const result = await harness.service.createPayment(
                order.id,
                'user-1',
                { channel: PaymentChannel.WECHAT_VIRTUAL, code: 'login-code' },
            );

            expect(result).toMatchObject({
                channel: PaymentChannel.WECHAT_VIRTUAL,
                mode: 'short_series_goods',
                paySig: 'pay-sig',
                signature: 'signature',
            });
            expect(result.outTradeNo).toMatch(/^V[0-9A-Z]{8,31}$/);

            expect(harness.client.buildPayData).toHaveBeenCalledWith(
                expect.objectContaining({
                    productId: 'beacon_pro_month',
                    goodsPrice: 2900,
                    attach: order.orderNo,
                    sessionKey: 'session-key',
                }),
            );
            expect(harness.tx.paymentAttempt.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    orderId: order.id,
                    channel: PaymentChannel.WECHAT_VIRTUAL,
                    openid: 'o_user_openid',
                    productId: 'beacon_pro_month',
                    amount: 2900,
                    env: 0,
                }),
            });
        });

        it('generates a fresh outTradeNo for every attempt', async () => {
            const harness = createHarness();

            const first = await harness.service.createPayment(
                order.id,
                'user-1',
                {
                    channel: PaymentChannel.WECHAT_VIRTUAL,
                    code: 'login-code',
                },
            );
            const second = await harness.service.createPayment(
                order.id,
                'user-1',
                { channel: PaymentChannel.WECHAT_VIRTUAL, code: 'login-code' },
            );

            expect(first.outTradeNo).not.toBe(second.outTradeNo);
        });

        it('requires a wx.login code', async () => {
            const harness = createHarness();

            await expect(
                harness.service.createPayment(order.id, 'user-1', {
                    channel: PaymentChannel.WECHAT_VIRTUAL,
                }),
            ).rejects.toMatchObject({
                response: { code: 'MINIPROGRAM_CODE_REQUIRED' },
            });
        });

        it('rejects accounts without a mini-program identity', async () => {
            const harness = createHarness();
            harness.prisma.userIdentity.findFirst.mockResolvedValue(null);

            await expect(
                harness.service.createPayment(order.id, 'user-1', {
                    channel: PaymentChannel.WECHAT_VIRTUAL,
                    code: 'login-code',
                }),
            ).rejects.toMatchObject({
                response: { code: 'MINIPROGRAM_NOT_BOUND' },
            });
        });

        it('rejects a code that belongs to another mini-program user', async () => {
            const harness = createHarness();
            harness.miniprogramClient.code2Session.mockResolvedValue({
                openid: 'o_someone_else',
                sessionKey: 'session-key',
            });

            await expect(
                harness.service.createPayment(order.id, 'user-1', {
                    channel: PaymentChannel.WECHAT_VIRTUAL,
                    code: 'login-code',
                }),
            ).rejects.toMatchObject({
                response: { code: 'MINIPROGRAM_OPENID_MISMATCH' },
            });
        });

        it('refuses a term without a mapped WeChat product', async () => {
            const harness = createHarness();
            harness.prisma.planTerm.findUnique.mockResolvedValue({
                id: 'term-1',
                price: 2900,
                wechatProductId: null,
            });

            await expect(
                harness.service.createPayment(order.id, 'user-1', {
                    channel: PaymentChannel.WECHAT_VIRTUAL,
                    code: 'login-code',
                }),
            ).rejects.toMatchObject({
                response: { code: 'VIRTUAL_PRODUCT_NOT_MAPPED' },
            });
        });
    });

    describe('handleNotify', () => {
        it('settles a paid order and replies with ErrCode 0', async () => {
            const harness = createHarness();

            const result = await harness.service.handleNotify({
                rawBody: deliverXml(),
                query: {},
            });

            expect(result.reply).toContain('<ErrCode>0</ErrCode>');
            expect(result.handled).toBe(true);

            // 结算：订单置 PAID + 订阅激活 + 通知
            expect(harness.tx.order.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: order.id },
                    data: expect.objectContaining({ status: 'PAID' }),
                }),
            );
            expect(harness.notifications.publish).toHaveBeenCalledWith(
                expect.objectContaining({ title: 'Payment received' }),
                expect.anything(),
            );
            expect(harness.tx.paymentAttempt.create).not.toHaveBeenCalled();
        });

        it('is idempotent for a repeated push', async () => {
            const harness = createHarness({
                attempt: {
                    id: 'attempt-1',
                    orderId: order.id,
                    channel: PaymentChannel.WECHAT_VIRTUAL,
                    outTradeNo: 'VABC123456789',
                    openid: 'o_user_openid',
                    productId: 'beacon_pro_month',
                    amount: 2900,
                    env: 0,
                    status: 'PAID',
                    wxOrderId: 'wx_order_1',
                    paidAt: new Date(),
                    rawNotify: null,
                    order,
                },
            });

            const result = await harness.service.handleNotify({
                rawBody: deliverXml(),
                query: {},
            });

            expect(result.reply).toContain('<ErrCode>0</ErrCode>');
            expect(result.handled).toBe(false);
            expect(harness.tx.paymentAttempt.updateMany).not.toHaveBeenCalled();
            expect(harness.notifications.publish).not.toHaveBeenCalled();
        });

        it('rejects a push whose amount does not match the order', async () => {
            const harness = createHarness();

            const result = await harness.service.handleNotify({
                rawBody: deliverXml({ actualPrice: 1 }),
                query: {},
            });

            expect(result.reply).toContain('<ErrCode>-1</ErrCode>');
            expect(harness.tx.paymentAttempt.updateMany).not.toHaveBeenCalled();
        });

        it('rejects a push that query_order does not confirm', async () => {
            const harness = createHarness({ queryStatus: 1 });

            const result = await harness.service.handleNotify({
                rawBody: deliverXml(),
                query: {},
            });

            expect(result.reply).toContain('<ErrCode>-1</ErrCode>');
            expect(harness.tx.order.update).not.toHaveBeenCalled();
        });

        it('fails when neither the attempt nor the attached order exists', async () => {
            const harness = createHarness({ attempt: null });
            harness.prisma.order.findFirst.mockResolvedValue(null);

            const result = await harness.service.handleNotify({
                rawBody: deliverXml(),
                query: {},
            });

            expect(result.reply).toContain('<ErrCode>-1</ErrCode>');
        });

        it('replies 0 for events it does not handle (so WeChat stops retrying)', async () => {
            const harness = createHarness();

            const result = await harness.service.handleNotify({
                rawBody:
                    '<xml><Event><![CDATA[xpay_complaint_notify]]></Event></xml>',
                query: {},
            });

            expect(result.reply).toContain('<ErrCode>0</ErrCode>');
            expect(result.handled).toBe(false);
        });
    });

    describe('settlement guards', () => {
        it('does not activate the subscription twice when another payment already succeeded', async () => {
            const harness = createHarness();
            harness.tx.payment.findUnique.mockResolvedValue({
                id: 'payment-existing',
                orderId: order.id,
                transactionId: 'wx_order_other',
                status: PaymentStatus.SUCCESS,
                channel: PaymentChannel.WECHAT_VIRTUAL,
                outTradeNo: 'V_WINNER',
            });

            const result = await harness.service.handleNotify({
                rawBody: deliverXml(),
                query: {},
            });

            expect(result.reply).toContain('<ErrCode>0</ErrCode>');
            expect(harness.tx.order.update).not.toHaveBeenCalled();
            // 重复支付必须告警给管理员
            expect(harness.notifications.publish).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: 'Duplicate payment detected',
                }),
                expect.anything(),
            );
        });
    });

    describe('reconcilePendingAttempts', () => {
        it('delivers a paid attempt whose push was lost', async () => {
            const harness = createHarness();
            harness.prisma.paymentAttempt.findMany.mockResolvedValue([
                {
                    id: 'attempt-1',
                    orderId: order.id,
                    channel: PaymentChannel.WECHAT_VIRTUAL,
                    outTradeNo: 'VABC123456789',
                    openid: 'o_user_openid',
                    productId: 'beacon_pro_month',
                    amount: 2900,
                    env: 0,
                    status: 'PENDING',
                    wxOrderId: null,
                    paidAt: null,
                    rawNotify: null,
                    order,
                },
            ]);

            const result = await harness.service.reconcilePendingAttempts();

            expect(result).toEqual({ checked: 1, settled: 1 });
            expect(harness.tx.order.update).toHaveBeenCalled();
        });

        it('leaves unpaid attempts alone', async () => {
            const harness = createHarness({ queryStatus: 1 });
            harness.prisma.paymentAttempt.findMany.mockResolvedValue([
                {
                    id: 'attempt-1',
                    orderId: order.id,
                    channel: PaymentChannel.WECHAT_VIRTUAL,
                    outTradeNo: 'VABC123456789',
                    openid: 'o_user_openid',
                    productId: 'beacon_pro_month',
                    amount: 2900,
                    env: 0,
                    status: 'PENDING',
                    wxOrderId: null,
                    paidAt: null,
                    rawNotify: null,
                    order,
                },
            ]);

            const result = await harness.service.reconcilePendingAttempts();

            expect(result).toEqual({ checked: 1, settled: 0 });
            expect(harness.tx.order.update).not.toHaveBeenCalled();
        });
    });

    describe('refund (RefundProvider)', () => {
        it('submits the channel-required refund fields with an enum reason', async () => {
            const harness = createHarness({ mock: false });

            const result = await harness.service.refund({
                outRefundNo: 'R123456',
                outTradeNo: order.orderNo,
                orderId: order.id,
                refundFee: 2900,
                totalFee: 2900,
                leftFee: 2900,
                reason: 'user changed their mind (free text)',
            });

            expect(harness.client.refundOrder).toHaveBeenCalledWith({
                openid: 'o_user_openid',
                outTradeNo: 'VABC123456789',
                env: 0,
                refundOrderId: 'R123456',
                leftFee: 2900,
                refundFee: 2900,
                bizMeta: 'BWMB3KXABC123',
                reason: '5',
                reqFrom: '3',
            });
            expect(result.status).toBe('PROCESSING');
        });
    });

    describe('refund notify', () => {
        it('records an external refund while closing an unsubmitted request without approving it', async () => {
            const h = createHarness();
            h.tx.payment.findUnique.mockResolvedValue({
                id: 'payment-1',
                status: PaymentStatus.SUCCESS,
                amount: 2900,
                refundedAmount: 0,
            });
            h.tx.refund.findFirst.mockResolvedValue({
                id: 'pending-refund',
                status: 'PENDING',
                submittedAt: null,
            });
            const result = await h.service.handleNotify({
                rawBody: JSON.stringify({
                    Event: 'xpay_refund_notify',
                    OutTradeNo: 'VABC123456789',
                    WeChatPayInfo: { RefundFee: 2900, RefundId: 'external' },
                }),
                query: {},
            });
            expect(result.handled).toBe(true);
            expect(h.refunds.markSuccess).not.toHaveBeenCalled();
            expect(h.tx.refund.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 'pending-refund' },
                    data: expect.objectContaining({ status: 'CLOSED' }),
                }),
            );
            expect(h.tx.refund.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: 'SUCCESS',
                        amount: 2900,
                    }),
                }),
            );
            expect(h.tx.subscription.update).not.toHaveBeenCalled();
        });

        it('does not book an external refund twice after another callback settles it', async () => {
            const h = createHarness();
            h.tx.payment.findUnique.mockResolvedValue({
                status: PaymentStatus.REFUNDED,
            });
            const result = await h.service.handleNotify({
                rawBody: JSON.stringify({
                    Event: 'xpay_refund_notify',
                    OutTradeNo: 'VABC123456789',
                    WeChatPayInfo: { RefundFee: 2900 },
                }),
                query: {},
            });
            expect(result.handled).toBe(false);
            expect(h.tx.refund.create).not.toHaveBeenCalled();
            expect(h.tx.payment.update).not.toHaveBeenCalled();
        });

        it('rejects external amounts exceeding either remaining balance', async () => {
            const h = createHarness();
            h.tx.payment.findUnique.mockResolvedValue({
                status: PaymentStatus.SUCCESS,
                amount: 2900,
                refundedAmount: 1,
            });
            const result = await h.service.handleNotify({
                rawBody: JSON.stringify({
                    Event: 'xpay_refund_notify',
                    OutTradeNo: 'VABC123456789',
                    WeChatPayInfo: { RefundFee: 2900 },
                }),
                query: {},
            });
            expect(JSON.parse(result.reply).ErrCode).toBe(-1);
            expect(h.tx.refund.create).not.toHaveBeenCalled();
        });

        it('marks the order and payment as refunded without touching the subscription', async () => {
            const harness = createHarness();
            harness.tx.payment.findUnique.mockResolvedValue({
                id: 'payment-1',
                status: PaymentStatus.SUCCESS,
                amount: 2900,
                refundedAmount: 0,
            });
            harness.prisma.payment.findUnique.mockResolvedValue({
                id: 'payment-1',
                orderId: order.id,
                status: PaymentStatus.SUCCESS,
                channel: PaymentChannel.WECHAT_VIRTUAL,
                outTradeNo: 'VABC123456789',
            });

            const result = await harness.service.handleNotify({
                rawBody: `<xml>
                    <Event><![CDATA[xpay_refund_notify]]></Event>
                    <OpenId><![CDATA[o_user_openid]]></OpenId>
                    <OutTradeNo><![CDATA[VABC123456789]]></OutTradeNo>
                    <Env>0</Env>
                    <WeChatPayInfo>
                        <MchOrderNo><![CDATA[wx_order_1]]></MchOrderNo>
                        <RefundId><![CDATA[wx_refund_1]]></RefundId>
                        <RefundFee>2900</RefundFee>
                        <OrderFee>2900</OrderFee>
                    </WeChatPayInfo>
                </xml>`,
                query: {},
            });

            expect(result.reply).toContain('<ErrCode>0</ErrCode>');
            expect(result.handled).toBe(true);
            expect(harness.tx.payment.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: PaymentStatus.REFUNDED,
                    }),
                }),
            );
            expect(harness.tx.order.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: 'REFUNDED' }),
                }),
            );
            // 订阅不自动回收
            expect(harness.tx.subscription.update).not.toHaveBeenCalled();
        });

        it('routes through the unified refund path when a local refund is in flight', async () => {
            const harness = createHarness();
            harness.prisma.payment.findUnique.mockResolvedValue({
                id: 'payment-1',
                orderId: order.id,
                status: PaymentStatus.SUCCESS,
                channel: PaymentChannel.WECHAT_VIRTUAL,
                outTradeNo: 'VABC123456789',
            });
            harness.tx.refund.findFirst.mockResolvedValue({
                id: 'refund-1',
                submittedAt: new Date(),
            });

            const result = await harness.service.handleNotify({
                rawBody: `<xml>
                    <Event><![CDATA[xpay_refund_notify]]></Event>
                    <OpenId><![CDATA[o_user_openid]]></OpenId>
                    <OutTradeNo><![CDATA[VABC123456789]]></OutTradeNo>
                    <Env>0</Env>
                    <WeChatPayInfo>
                        <MchOrderNo><![CDATA[wx_order_1]]></MchOrderNo>
                        <RefundId><![CDATA[wx_refund_1]]></RefundId>
                        <RefundFee>2900</RefundFee>
                    </WeChatPayInfo>
                </xml>`,
                query: {},
            });

            expect(result.handled).toBe(true);
            // 有本地申请记录：交给 RefundService 结算（会回收订阅）
            expect(harness.refunds.markSuccess).toHaveBeenCalledWith(
                'refund-1',
                expect.objectContaining({
                    status: 'SUCCESS',
                    channelRefundId: 'wx_refund_1',
                }),
            );
            // 推送侧不再重复改订单/支付
            expect(harness.tx.order.update).not.toHaveBeenCalled();
        });
    });
});

describe('WechatVirtualPaymentService (JSON pushes)', () => {
    it.each([2, 3, 4])(
        'allows original-key recovery when query_order reports ordinary paid status %s',
        async (queryStatus) => {
            const h = createHarness({ queryStatus });
            expect(
                await h.service.queryRefund({
                    orderId: order.id,
                    outTradeNo: 'VABC123456789',
                    refundNo: 'RF1',
                }),
            ).toMatchObject({ status: 'PROCESSING', notFound: true });
        },
    );

    it.each([0, 1, 6, 9, 10])(
        'does not infer refund absence from unrelated order status %s',
        async (queryStatus) => {
            const h = createHarness({ queryStatus });
            expect(
                await h.service.queryRefund({
                    orderId: order.id,
                    outTradeNo: 'VABC123456789',
                    refundNo: 'RF1',
                }),
            ).not.toHaveProperty('notFound');
        },
    );

    it('settles a JSON goods-deliver push and replies in JSON', async () => {
        const harness = createHarness();

        const result = await harness.service.handleNotify({
            rawBody: deliverJson(),
            query: {},
        });

        expect(result.contentType).toBe('application/json');
        expect(JSON.parse(result.reply)).toEqual({
            ErrCode: 0,
            ErrMsg: 'success',
        });
        expect(result.handled).toBe(true);
        expect(harness.tx.order.update).toHaveBeenCalled();
    });

    it('rejects a JSON push whose amount does not match', async () => {
        const harness = createHarness();

        const result = await harness.service.handleNotify({
            rawBody: deliverJson({ actualPrice: 1 }),
            query: {},
        });

        expect(result.contentType).toBe('application/json');
        expect(JSON.parse(result.reply).ErrCode).toBe(-1);
        expect(harness.tx.order.update).not.toHaveBeenCalled();
    });

    it('still answers in XML when the console pushes XML', async () => {
        const harness = createHarness();

        const result = await harness.service.handleNotify({
            rawBody: deliverXml(),
            query: {},
        });

        expect(result.contentType).toBe('text/xml');
        expect(result.reply).toContain('<ErrCode>0</ErrCode>');
    });

    it('settles a JSON refund push', async () => {
        const harness = createHarness();
        harness.tx.payment.findUnique.mockResolvedValue({
            id: 'payment-1',
            status: PaymentStatus.SUCCESS,
            amount: 2900,
            refundedAmount: 0,
        });
        harness.prisma.payment.findUnique.mockResolvedValue({
            id: 'payment-1',
            orderId: order.id,
            status: PaymentStatus.SUCCESS,
            channel: PaymentChannel.WECHAT_VIRTUAL,
            outTradeNo: 'VABC123456789',
        });

        const result = await harness.service.handleNotify({
            rawBody: JSON.stringify({
                Event: 'xpay_refund_notify',
                OpenId: 'o_user_openid',
                OutTradeNo: 'VABC123456789',
                Env: 0,
                WeChatPayInfo: {
                    MchOrderNo: 'wx_order_1',
                    RefundId: 'wx_refund_1',
                    RefundFee: 2900,
                    OrderFee: 2900,
                },
            }),
            query: {},
        });

        expect(JSON.parse(result.reply)).toEqual({
            ErrCode: 0,
            ErrMsg: 'success',
        });
        expect(harness.tx.payment.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: PaymentStatus.REFUNDED,
                }),
            }),
        );
    });
});
