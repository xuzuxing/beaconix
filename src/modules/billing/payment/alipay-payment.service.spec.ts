import type {
    AlipayClient,
    AlipayRuntimeConfigService,
} from '../../../infra/alipay';
import { AlipayApiError, AlipayPayMethod } from '../../../infra/alipay';
import type { AlipayConfig } from '../../../config';
import {
    AlipayPaymentService,
    ALIPAY_NOTIFY_ERROR_CODES,
    parseNotifyParams,
    payMethodOf,
    yuanFromFen,
} from './alipay-payment.service';

const config: AlipayConfig = {
    appId: '2021000000000001',
    privateKey: 'private',
    publicKey: 'public',
    gateway: 'https://openapi.alipay.com/gateway.do',
    signType: 'RSA2',
    sandbox: false,
    notifyUrl: 'https://api.example.com/api/payment/alipay/callback',
    returnUrl: 'https://app.example.com/orders/BW123',
    mock: true,
};

function createService(overrides: Partial<AlipayConfig> = {}) {
    const resolved: AlipayConfig = { ...config, ...overrides };
    const client = {
        buildCashierUrl: jest.fn().mockResolvedValue('https://cashier.page'),
        buildWapCashierUrl: jest.fn().mockResolvedValue('https://cashier.wap'),
        precreate: jest
            .fn()
            .mockResolvedValue({ qrCode: 'https://qr.alipay.com/bax0123' }),
        verifyNotify: jest.fn().mockResolvedValue(true),
        refund: jest.fn(),
        queryRefund: jest.fn(),
    };
    const runtimeConfig = {
        config: jest.fn().mockResolvedValue(resolved),
    };

    const service = new AlipayPaymentService(
        client as unknown as AlipayClient,
        runtimeConfig as unknown as AlipayRuntimeConfigService,
    );

    return { service, client, runtimeConfig, config: resolved };
}

/** 支付宝异步通知的 form-urlencoded 报文。 */
function notifyBody(overrides: Record<string, string> = {}): string {
    return new URLSearchParams({
        app_id: config.appId,
        out_trade_no: 'BWABC123',
        trade_no: '2026102122001400000000000001',
        trade_status: 'TRADE_SUCCESS',
        total_amount: '29.00',
        sign: 'signature',
        sign_type: 'RSA2',
        ...overrides,
    }).toString();
}

describe('AlipayPaymentService', () => {
    it('declares the ALIPAY channel', () => {
        const { service } = createService();

        expect(service.channel).toBe('ALIPAY');
    });

    describe('createPayment', () => {
        it('returns mock params without touching Alipay when mock is on', async () => {
            const { service, client } = createService();

            const params = await service.createPayment({
                outTradeNo: 'BWABC123',
                totalFee: 2900,
                body: 'Beaconix plan order BWABC123',
            });

            expect(client.buildCashierUrl).not.toHaveBeenCalled();
            expect(client.precreate).not.toHaveBeenCalled();
            expect(params).toMatchObject({
                payMethod: AlipayPayMethod.PAGE,
                outTradeNo: 'BWABC123',
                totalAmount: '29.00',
            });
            expect(String(params['payUrl'])).toContain('out_trade_no=BWABC123');
            expect(String(params['payUrl'])).toContain('mock=true');
        });

        it('creates a page cashier URL by default', async () => {
            const { service, client } = createService({ mock: false });

            const params = await service.createPayment({
                outTradeNo: 'BWABC123',
                totalFee: 999,
                body: 'Beaconix plan order BWABC123',
            });

            expect(client.buildCashierUrl).toHaveBeenCalledWith({
                outTradeNo: 'BWABC123',
                // 分 → 元，两位小数
                totalAmount: '9.99',
                subject: 'Beaconix plan order BWABC123',
                notifyUrl: config.notifyUrl,
                returnUrl: config.returnUrl,
            });
            expect(params).toMatchObject({
                payMethod: AlipayPayMethod.PAGE,
                payUrl: 'https://cashier.page',
                totalAmount: '9.99',
            });
        });

        it('creates a wap cashier URL when asked for the mobile flow', async () => {
            const { service, client } = createService({ mock: false });

            const params = await service.createPayment({
                outTradeNo: 'BWABC123',
                totalFee: 100,
                body: 'subject',
                payMethod: AlipayPayMethod.WAP,
            });

            expect(client.buildWapCashierUrl).toHaveBeenCalledWith(
                expect.objectContaining({ totalAmount: '1.00' }),
            );
            expect(client.buildCashierUrl).not.toHaveBeenCalled();
            expect(params).toMatchObject({ payUrl: 'https://cashier.wap' });
        });

        it('returns the QR link for the native (precreate) flow', async () => {
            const { service, client } = createService({ mock: false });

            const params = await service.createPayment({
                outTradeNo: 'BWABC123',
                totalFee: 2900,
                body: 'subject',
                payMethod: AlipayPayMethod.PRECREATE,
            });

            expect(client.precreate).toHaveBeenCalledWith({
                outTradeNo: 'BWABC123',
                totalAmount: '29.00',
                subject: 'subject',
                notifyUrl: config.notifyUrl,
                returnUrl: config.returnUrl,
            });
            expect(params).toMatchObject({
                payMethod: AlipayPayMethod.PRECREATE,
                qrCode: 'https://qr.alipay.com/bax0123',
                payUrl: 'https://qr.alipay.com/bax0123',
            });
        });

        it('includes a QR link in the mock params of the native flow', async () => {
            const { service } = createService();

            const params = await service.createPayment({
                outTradeNo: 'BWABC123',
                totalFee: 2900,
                body: 'subject',
                payMethod: AlipayPayMethod.PRECREATE,
            });

            expect(params['qrCode']).toBe(params['payUrl']);
        });

        it('falls back to the page flow for unknown payMethod values', async () => {
            const { service, client } = createService({ mock: false });

            await service.createPayment({
                outTradeNo: 'BWABC123',
                totalFee: 2900,
                body: 'subject',
                payMethod: 'alipay.trade.app.pay',
            });

            expect(client.buildCashierUrl).toHaveBeenCalled();
        });
    });

    describe('verifyCallback', () => {
        it('maps TRADE_SUCCESS to SUCCESS', async () => {
            const { service } = createService({ mock: false });

            const result = await service.verifyCallback(notifyBody());

            expect(result).toMatchObject({
                out_trade_no: 'BWABC123',
                transaction_id: '2026102122001400000000000001',
                trade_state: 'SUCCESS',
                trade_status: 'TRADE_SUCCESS',
            });
        });

        it('maps TRADE_FINISHED to SUCCESS', async () => {
            const { service } = createService({ mock: false });

            await expect(
                service.verifyCallback(
                    notifyBody({ trade_status: 'TRADE_FINISHED' }),
                ),
            ).resolves.toMatchObject({ trade_state: 'SUCCESS' });
        });

        it('keeps non-success states so handleCallback refuses them', async () => {
            const { service } = createService({ mock: false });

            for (const tradeStatus of ['WAIT_BUYER_PAY', 'TRADE_CLOSED']) {
                await expect(
                    service.verifyCallback(
                        notifyBody({ trade_status: tradeStatus }),
                    ),
                ).resolves.toMatchObject({
                    trade_state: tradeStatus,
                });
            }
        });

        it('verifies the signature in real mode', async () => {
            const { service, client } = createService({ mock: false });

            await service.verifyCallback(notifyBody());

            expect(client.verifyNotify).toHaveBeenCalledWith(
                expect.objectContaining({
                    out_trade_no: 'BWABC123',
                    sign: 'signature',
                }),
            );
        });

        it('rejects a bad signature', async () => {
            const { service, client } = createService({ mock: false });
            client.verifyNotify.mockResolvedValue(false);

            await expect(service.verifyCallback(notifyBody())).rejects.toThrow(
                AlipayApiError,
            );
        });

        it('skips verification in mock mode so the flow stays testable', async () => {
            const { service, client } = createService();

            await service.verifyCallback(notifyBody());

            expect(client.verifyNotify).not.toHaveBeenCalled();
        });

        it('rejects a notification from another Alipay app', async () => {
            const { service } = createService({ mock: false });

            await expect(
                service.verifyCallback(
                    notifyBody({ app_id: '2021999999999999' }),
                ),
            ).rejects.toThrow(/does not match the configured app/);
        });

        it('rejects a notification without out_trade_no', async () => {
            const { service } = createService();

            await expect(
                service.verifyCallback(
                    new URLSearchParams({
                        trade_status: 'TRADE_SUCCESS',
                    }).toString(),
                ),
            ).rejects.toThrow(/missing out_trade_no/);
        });

        it('tags every rejection with a reason code for the callback log', async () => {
            const { service, client } = createService({ mock: false });

            // 缺参数：带上收到的参数名与报文长度，空报文也能一眼分辨。
            await expect(service.verifyCallback('')).rejects.toMatchObject({
                code: ALIPAY_NOTIFY_ERROR_CODES.MISSING_OUT_TRADE_NO,
                message: expect.stringContaining('empty notification body'),
            });

            await expect(
                service.verifyCallback(
                    new URLSearchParams({
                        trade_status: 'TRADE_SUCCESS',
                    }).toString(),
                ),
            ).rejects.toMatchObject({
                code: ALIPAY_NOTIFY_ERROR_CODES.MISSING_OUT_TRADE_NO,
                message: expect.stringContaining('trade_status'),
            });

            // 验签失败与 app_id 串台各有自己的码。
            client.verifyNotify.mockResolvedValue(false);
            await expect(
                service.verifyCallback(notifyBody()),
            ).rejects.toMatchObject({
                code: ALIPAY_NOTIFY_ERROR_CODES.SIGN_INVALID,
            });

            client.verifyNotify.mockResolvedValue(true);
            await expect(
                service.verifyCallback(
                    notifyBody({ app_id: '2021999999999999' }),
                ),
            ).rejects.toMatchObject({
                code: ALIPAY_NOTIFY_ERROR_CODES.APP_ID_MISMATCH,
            });
        });
    });
    describe('refund', () => {
        const refundInput = {
            outRefundNo: 'RF1',
            outTradeNo: 'BWABC123',
            refundFee: 19933,
            totalFee: 29900,
            reason: 'not satisfied',
        };

        it('short-circuits in mock mode', async () => {
            const { service, client } = createService();

            const result = await service.refund(refundInput);

            expect(result.status).toBe('SUCCESS');
            expect(client.refund).not.toHaveBeenCalled();
        });

        it('converts cents to yuan and submits the refund', async () => {
            const { service, client } = createService({ mock: false });
            client.refund.mockResolvedValue({
                code: '10000',
                msg: 'Success',
                fundChange: 'Y',
            });

            const result = await service.refund(refundInput);

            expect(client.refund).toHaveBeenCalledWith({
                outTradeNo: 'BWABC123',
                outRefundNo: 'RF1',
                // 19933 分 = 199.33 元
                refundAmount: '199.33',
                reason: 'not satisfied',
            });
            expect(result.status).toBe('SUCCESS');
        });

        it('treats a repeated request (fund_change=N) as success', async () => {
            const { service, client } = createService({ mock: false });
            client.refund.mockResolvedValue({
                code: '10000',
                msg: 'Success',
                // 同号重复请求：钱已经退过了，不会再退一次
                fundChange: 'N',
            });

            await expect(service.refund(refundInput)).resolves.toMatchObject({
                status: 'SUCCESS',
            });
        });

        it('throws AlipayApiError when Alipay rejects the refund', async () => {
            const { service, client } = createService({ mock: false });
            client.refund.mockResolvedValue({
                code: '40004',
                msg: 'Business Failed',
                subCode: 'ACQ.SELLER_BALANCE_NOT_ENOUGH',
                subMsg: 'seller balance is not enough',
            });

            const error = await service.refund(refundInput).catch((e) => e);

            expect(error).toBeInstanceOf(AlipayApiError);
            expect(error.subCode).toBe('ACQ.SELLER_BALANCE_NOT_ENOUGH');
            expect(error.message).toContain('seller balance is not enough');
        });

        it('reads the refund state back for the reconcile job', async () => {
            const { service, client } = createService({ mock: false });
            client.queryRefund.mockResolvedValue({
                code: '10000',
                msg: 'Success',
                refundStatus: 'REFUND_SUCCESS',
            });

            const result = await service.queryRefund({
                refundNo: 'RF1',
                outTradeNo: 'BWABC123',
            });

            expect(client.queryRefund).toHaveBeenCalledWith({
                outTradeNo: 'BWABC123',
                outRefundNo: 'RF1',
            });
            expect(result.status).toBe('SUCCESS');
        });

        it('keeps an unknown refund as PROCESSING while polling', async () => {
            const { service, client } = createService({ mock: false });
            client.queryRefund.mockResolvedValue({
                code: '40004',
                msg: 'Business Failed',
                subCode: 'ACQ.REFUND_NOT_EXIST',
            });

            await expect(
                service.queryRefund({
                    refundNo: 'RF1',
                    outTradeNo: 'BWABC123',
                }),
            ).resolves.toMatchObject({ status: 'PROCESSING' });
        });
    });
});

describe('yuanFromFen', () => {
    it.each([
        [999, '9.99'],
        [100, '1.00'],
        [2900, '29.00'],
        [5, '0.05'],
        [0, '0.00'],
        [1, '0.01'],
        [1000000, '10000.00'],
    ])('converts %i cents to %s', (fen, expected) => {
        expect(yuanFromFen(fen)).toBe(expected);
    });

    it('rejects amounts that are not non-negative integers', () => {
        expect(() => yuanFromFen(-1)).toThrow();
        expect(() => yuanFromFen(9.99)).toThrow();
        expect(() => yuanFromFen(Number.NaN)).toThrow();
    });
});

describe('parseNotifyParams', () => {
    it('parses the form-urlencoded body', () => {
        expect(
            parseNotifyParams('out_trade_no=BW1&trade_status=TRADE_SUCCESS'),
        ).toEqual({
            out_trade_no: 'BW1',
            trade_status: 'TRADE_SUCCESS',
        });
    });

    it('drops empty values so verification is not polluted', () => {
        expect(parseNotifyParams('out_trade_no=BW1&buyer_id=&sign=x')).toEqual({
            out_trade_no: 'BW1',
            sign: 'x',
        });
    });

    it('does not decode values twice', () => {
        expect(
            parseNotifyParams('subject=Beaconix%20plan%20order%20BW1'),
        ).toEqual({
            subject: 'Beaconix plan order BW1',
        });
    });
});

describe('payMethodOf', () => {
    it('accepts the three supported product codes', () => {
        expect(payMethodOf('alipay.trade.page.pay')).toBe(AlipayPayMethod.PAGE);
        expect(payMethodOf('alipay.trade.wap.pay')).toBe(AlipayPayMethod.WAP);
        expect(payMethodOf('alipay.trade.precreate')).toBe(
            AlipayPayMethod.PRECREATE,
        );
    });

    it('defaults everything else to page.pay', () => {
        expect(payMethodOf(undefined)).toBe(AlipayPayMethod.PAGE);
        expect(payMethodOf('alipay.trade.app.pay')).toBe(AlipayPayMethod.PAGE);
    });
});
