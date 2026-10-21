import { createHash } from 'node:crypto';
import { PaymentChannel, PaymentStatus } from '../../../generated/prisma/enums';
import type { PrismaService } from '../../../infra/database/prisma.service';
import type { MiniprogramClient } from '../../../infra/wechat/miniprogram';
import type { WechatRuntimeConfigService } from '../../../infra/wechat';
import type { WechatVirtualPayClient } from '../../../infra/wechat';
import type { NotificationsService } from '../../notifications/notifications.service';
import type { PaymentService } from './payment.service';
import { WechatVirtualPaymentService } from './wechat-virtual-payment.service';

const order = {
    id: 'order-1',
    orderNo: 'BWMB3KXABC123',
    organizationId: 'org-1',
    planId: 'plan-pro',
    userId: 'user-1',
    amount: 2900,
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
        order: { update: jest.fn().mockResolvedValue(order) },
        payment: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: 'payment-1' }),
            update: jest.fn().mockResolvedValue({ id: 'payment-1' }),
        },
        paymentAttempt: {
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
        },
        payment: { findUnique: jest.fn().mockResolvedValue(null) },
        order: {
            findFirst: jest.fn().mockResolvedValue(order),
            update: jest.fn(),
        },
        $transaction: jest.fn(
            async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
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

    const service = new WechatVirtualPaymentService(
        prisma as unknown as PrismaService,
        paymentService as unknown as PaymentService,
        notifications as unknown as NotificationsService,
        client as unknown as WechatVirtualPayClient,
        miniprogramClient as unknown as MiniprogramClient,
        runtimeConfig as unknown as WechatRuntimeConfigService,
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
    };
}

describe('WechatVirtualPaymentService', () => {
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
            expect(harness.prisma.paymentAttempt.create).toHaveBeenCalledWith({
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
            expect(harness.prisma.paymentAttempt.create).not.toHaveBeenCalled();
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

    describe('refund notify', () => {
        it('marks the order and payment as refunded without touching the subscription', async () => {
            const harness = createHarness();
            harness.prisma.payment.findUnique.mockResolvedValue({
                id: 'payment-1',
                orderId: order.id,
                status: PaymentStatus.SUCCESS,
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
    });
});

describe('WechatVirtualPaymentService (JSON pushes)', () => {
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
        harness.prisma.payment.findUnique.mockResolvedValue({
            id: 'payment-1',
            orderId: order.id,
            status: PaymentStatus.SUCCESS,
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
