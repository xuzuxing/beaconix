import type { WechatPayClient } from '../../../infra/wechat/pay';
import type { WechatRuntimeConfigService } from '../../../infra/wechat/wechat-runtime-config.service';
import { WechatPaymentService } from './wechat-payment.service';

function createService(mock: boolean) {
    const payClient = {
        createJsapiTransaction: jest.fn(),
        buildJsapiPayParams: jest.fn(),
        parseNotification: jest.fn(),
        createRefund: jest.fn(),
        queryRefund: jest.fn(),
        queryTransaction: jest.fn(),
        closeTransaction: jest.fn(),
        parseRefundNotification: jest.fn(),
    };
    const runtimeConfig = {
        pay: jest.fn().mockResolvedValue({ mock }),
    };

    const service = new WechatPaymentService(
        payClient as unknown as WechatPayClient,
        runtimeConfig as unknown as WechatRuntimeConfigService,
    );

    return { service, payClient, runtimeConfig };
}

describe('WechatPaymentService', () => {
    it('queries and closes through the authenticated V3 client', async () => {
        const { service, payClient } = createService(false);
        const result = {
            out_trade_no: 'P1',
            trade_state: 'SUCCESS',
            amount: { total: 100 },
        };
        payClient.queryTransaction.mockResolvedValue(result);
        expect(await service.queryPayment('P1')).toEqual(result);
        await service.closePayment('P1');
        expect(payClient.queryTransaction).toHaveBeenCalledWith('P1');
        expect(payClient.closeTransaction).toHaveBeenCalledWith('P1');
    });

    it('never invents paid funds when querying in mock mode', async () => {
        const { service, payClient } = createService(true);
        expect((await service.queryPayment('P1')).trade_state).toBe('NOTPAY');
        await service.closePayment('P1');
        expect(payClient.queryTransaction).not.toHaveBeenCalled();
        expect(payClient.closeTransaction).not.toHaveBeenCalled();
    });

    it('forwards order expiry to V3', async () => {
        const { service, payClient } = createService(false);
        payClient.createJsapiTransaction.mockResolvedValue({ prepayId: 'id' });
        const expiresAt = new Date('2026-10-30T00:00:00Z');
        await service.createPayment({
            outTradeNo: 'P1',
            totalFee: 100,
            payerId: 'o',
            body: 'order',
            expiresAt,
        });
        expect(payClient.createJsapiTransaction).toHaveBeenCalledWith(
            expect.objectContaining({ timeExpire: expiresAt.toISOString() }),
        );
    });

    it.each([true, false])(
        'preserves refund amounts and payment identity (mock=%s)',
        async (mock) => {
            const { service, payClient } = createService(mock);
            const payload = {
                out_refund_no: 'RF1',
                refund_status: 'SUCCESS',
                out_trade_no: 'P1',
                transaction_id: 'TX1',
                amount: { refund: 50, total: 100, currency: 'CNY' },
            };
            payClient.parseRefundNotification = jest
                .fn()
                .mockResolvedValue(payload);
            expect(
                await service.parseRefundCallback(
                    JSON.stringify(payload),
                    'sig',
                ),
            ).toMatchObject({
                refundFee: 50,
                totalFee: 100,
                currency: 'CNY',
                outTradeNo: 'P1',
                transactionId: 'TX1',
            });
        },
    );
    describe('mock mode (WECHAT_PAY_MOCK=true)', () => {
        it('returns mock pay params without touching the Pay client', async () => {
            const { service, payClient } = createService(true);

            const params = await service.createPayment({
                outTradeNo: 'BW1',
                totalFee: 100,
                payerId: 'o_1',
                body: 'order',
            });

            expect(params.package).toBe('prepay_id=mock_BW1');
            expect(params.signType).toBe('RSA');
            expect(payClient.createJsapiTransaction).not.toHaveBeenCalled();
        });

        it('parses the callback body directly', async () => {
            const { service, payClient } = createService(true);

            const result = await service.verifyCallback(
                JSON.stringify({
                    out_trade_no: 'BW1',
                    transaction_id: 'tx-1',
                    trade_state: 'SUCCESS',
                }),
                'signature',
            );

            expect(result.trade_state).toBe('SUCCESS');
            expect(payClient.parseNotification).not.toHaveBeenCalled();
        });
    });

    describe('live mode (WECHAT_PAY_MOCK=false)', () => {
        it('creates a JSAPI transaction and signs the pay params', async () => {
            const { service, payClient } = createService(false);
            payClient.createJsapiTransaction.mockResolvedValue({
                prepayId: 'prepay-1',
            });
            payClient.buildJsapiPayParams.mockReturnValue({
                timeStamp: '1',
                nonceStr: 'n',
                package: 'prepay_id=prepay-1',
                signType: 'RSA',
                paySign: 's',
            });

            const params = await service.createPayment({
                outTradeNo: 'BW1',
                totalFee: 100,
                payerId: 'o_1',
                body: 'Beacon plan order BW1',
            });

            expect(payClient.createJsapiTransaction).toHaveBeenCalledWith({
                description: 'Beacon plan order BW1',
                outTradeNo: 'BW1',
                totalFee: 100,
                openid: 'o_1',
            });
            expect(payClient.buildJsapiPayParams).toHaveBeenCalledWith(
                'prepay-1',
            );
            expect(params.package).toBe('prepay_id=prepay-1');
        });

        it('verifies notifications with the WeChat signature headers', async () => {
            const { service, payClient } = createService(false);
            payClient.parseNotification.mockResolvedValue({
                out_trade_no: 'BW1',
                transaction_id: 'tx-1',
                trade_state: 'SUCCESS',
            });

            const headers = {
                'wechatpay-timestamp': '1',
                'wechatpay-nonce': 'n',
                'wechatpay-serial': 'SERIAL-1',
            };

            const result = await service.verifyCallback('{}', 'sig', headers);

            expect(payClient.parseNotification).toHaveBeenCalledWith('{}', {
                ...headers,
                'wechatpay-signature': 'sig',
            });
            expect(result.trade_state).toBe('SUCCESS');
        });
    });

    describe('refund', () => {
        const refundInput = {
            outRefundNo: 'RF1',
            outTradeNo: 'BW1',
            transactionId: 'tx-1',
            refundFee: 2900,
            totalFee: 2900,
            reason: 'not needed',
        };

        it('short-circuits in mock mode', async () => {
            const { service, payClient } = createService(true);

            const result = await service.refund(refundInput);

            expect(result).toMatchObject({
                status: 'SUCCESS',
                channelRefundId: 'mock_refund_RF1',
            });
            expect(payClient.createRefund).not.toHaveBeenCalled();
        });

        it('submits the refund and maps SUCCESS', async () => {
            const { service, payClient } = createService(false);
            payClient.createRefund.mockResolvedValue({
                refund_id: 'wx-refund-1',
                out_refund_no: 'RF1',
                status: 'SUCCESS',
            });

            const result = await service.refund(refundInput);

            expect(payClient.createRefund).toHaveBeenCalledWith({
                outRefundNo: 'RF1',
                outTradeNo: 'BW1',
                transactionId: 'tx-1',
                refundFee: 2900,
                totalFee: 2900,
                reason: 'not needed',
            });
            expect(result).toMatchObject({
                status: 'SUCCESS',
                channelRefundId: 'wx-refund-1',
            });
        });

        it.each(['PROCESSING', 'ABNORMAL'])(
            'keeps %s as PROCESSING instead of failing it',
            async (status) => {
                const { service, payClient } = createService(false);
                payClient.createRefund.mockResolvedValue({
                    refund_id: 'wx-refund-1',
                    out_refund_no: 'RF1',
                    status,
                });

                const result = await service.refund(refundInput);

                expect(result.status).toBe('PROCESSING');
                expect(result.failureReason).toBeUndefined();
            },
        );

        it('treats CLOSED as FAILED so it can be retried', async () => {
            const { service, payClient } = createService(false);
            payClient.createRefund.mockResolvedValue({
                refund_id: 'wx-refund-1',
                out_refund_no: 'RF1',
                status: 'CLOSED',
            });

            const result = await service.refund(refundInput);

            expect(result.status).toBe('FAILED');
            expect(result.failureReason).toContain('CLOSED');
        });

        it('queries a refund by its platform number', async () => {
            const { service, payClient } = createService(false);
            payClient.queryRefund.mockResolvedValue({
                refund_id: 'wx-refund-1',
                out_refund_no: 'RF1',
                status: 'SUCCESS',
            });

            const result = await service.queryRefund({
                refundNo: 'RF1',
                outTradeNo: 'BW1',
            });

            expect(payClient.queryRefund).toHaveBeenCalledWith('RF1');
            expect(result.status).toBe('SUCCESS');
        });
    });
});
