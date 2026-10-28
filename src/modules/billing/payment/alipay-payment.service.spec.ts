import { generateKeyPairSync, sign } from 'node:crypto';
import { AlipaySdk } from 'alipay-sdk';
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

        it('passes encoded and raw signatures to the SDK without corrupting signed values', async () => {
            const { service, client } = createService({ mock: false });
            const { privateKey, publicKey } = generateKeyPairSync('rsa', {
                modulusLength: 2048,
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            });
            const sdk = new AlipaySdk({
                appId: config.appId,
                privateKey,
                alipayPublicKey: publicKey,
                signType: 'RSA2',
            });
            const params = {
                app_id: config.appId,
                out_trade_no: 'BWABC123',
                trade_no: '2026102122001400000000000001',
                trade_status: 'TRADE_SUCCESS',
                total_amount: '29.00',
                subject: '订阅 C++ 100% %2B',
                gmt_payment: '2026-10-28 12:30:00',
                buyer_id: '',
            };
            const content = Object.entries(params)
                .sort(([firstKey], [secondKey]) =>
                    firstKey.localeCompare(secondKey),
                )
                .map(([key, value]) => `${key}=${value}`)
                .join('&');
            const signature = sign(
                'RSA-SHA256',
                Buffer.from(content),
                privateKey,
            ).toString('base64');
            client.verifyNotify.mockImplementation((notifyParams) =>
                Promise.resolve(sdk.checkNotifySignV2(notifyParams)),
            );

            for (const encodedSign of [
                encodeURIComponent(signature),
                signature,
            ]) {
                const body = `${new URLSearchParams(params).toString()}&sign_type=RSA2&sign=${encodedSign}`;

                await expect(
                    service.verifyCallback(body),
                ).resolves.toMatchObject({
                    out_trade_no: params.out_trade_no,
                    trade_state: 'SUCCESS',
                });
                expect(client.verifyNotify).toHaveBeenLastCalledWith({
                    ...params,
                    sign_type: 'RSA2',
                    sign: signature,
                });
            }
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
    it('parses the supplied sandbox notification with a raw signature and repeated fields', () => {
        const signature =
            'kPbQIjX+xQc8F0/A6/AocELIjhhZnGbcBN6G4MM/HmfWL4ZiHM6fWl5NQhzXJusaklZ1LFuMo+lHQUELAYeugH8LYFvxnNajOvZhuxNFbN2LhF0l/KL8ANtj8oyPM4NN7Qft2kWJTDJUpQOzCzNnV9hDxh5AaT9FPqRS6ZKxnzM=';
        const rawBody =
            'notify_time=2026-10-28 12:00:00&notify_type=trade_status_sync&notify_id=2026102800222001927128200510999999&sign=kPbQIjX+xQc8F0/A6/AocELIjhhZnGbcBN6G4MM/HmfWL4ZiHM6fWl5NQhzXJusaklZ1LFuMo+lHQUELAYeugH8LYFvxnNajOvZhuxNFbN2LhF0l/KL8ANtj8oyPM4NN7Qft2kWJTDJUpQOzCzNnV9hDxh5AaT9FPqRS6ZKxnzM=&sign_type=RSA2&trade_no=2026102822001428200510240999&app_id=9021000140652602&auth_app_id=9021000140652602&out_trade_no=TEST_ORDER_20261028_001&buyer_id=2088722040528202&buyer_logon_id=test***@sandbox.com&seller_id=2088721043529665&seller_email=mywesl5021@sandbox.com&trade_status=TRADE_SUCCESS&total_amount=0.01&receipt_amount=0.01&invoice_amount=0.01&buyer_pay_amount=0.01&point_amount=0.00&subject=Beaconix test order&gmt_create=2026-10-28 11:59:50&gmt_payment=2026-10-28 12:00:05&fund_bill_list=[{"amount":"0.01","fundChannel":"ALIPAYACCOUNT"}]Y&sign_type=RSA2&trade_no=2026102822001428200510240999&app_id=9021000140652602&auth_app_id=9021000140652602&out_trade_no=TEST_ORDER_20261028_001&buyer_id=2088722040528202&buyer_logon_id=test***@sandbox.com&seller_id=2088721043529665&seller_email=mywesl5021@sandbox.com&trade_status=TRADE_SUCCESS&total_amount=0.01&receipt_amount=0.01&invoice_amount=0.01&buyer_pay_amount=0.01&point_amount=0.00&subject=Beaconix test order&gmt_create=2026-10-28 11:59:50&gmt_payment=2026-10-28 12:00:05&fund_bill_list=[{"amount":"0.01","fundChannel":"ALIPAYACCOUNT"}]';

        expect(parseNotifyParams(rawBody)).toEqual({
            notify_time: '2026-10-28 12:00:00',
            notify_type: 'trade_status_sync',
            notify_id: '2026102800222001927128200510999999',
            sign: signature,
            sign_type: 'RSA2',
            trade_no: '2026102822001428200510240999',
            app_id: '9021000140652602',
            auth_app_id: '9021000140652602',
            out_trade_no: 'TEST_ORDER_20261028_001',
            buyer_id: '2088722040528202',
            buyer_logon_id: 'test***@sandbox.com',
            seller_id: '2088721043529665',
            seller_email: 'mywesl5021@sandbox.com',
            trade_status: 'TRADE_SUCCESS',
            total_amount: '0.01',
            receipt_amount: '0.01',
            invoice_amount: '0.01',
            buyer_pay_amount: '0.01',
            point_amount: '0.00',
            subject: 'Beaconix test order',
            gmt_create: '2026-10-28 11:59:50',
            gmt_payment: '2026-10-28 12:00:05',
            fund_bill_list: '[{"amount":"0.01","fundChannel":"ALIPAYACCOUNT"}]',
        });
    });

    it('parses notify.json sandbox data from a raw notification string', () => {
        const rawBody =
            'gmt_create=2026-10-27 18:18:05&charset=utf-8&seller_email=mywesl5021@sandbox.com&subject=Beaconix plan order BWMVQJ82493A449B6E&sign=AkTMkGQyBE3sCl3ZuEev4Xq1lfg4DATSwMbX9HFYvyLJlujpXdQRamYWiKoZTadVLQ6yw3zMcYrxj/yHna7WJ5My+/o8JHMmzA0I9wFfeXsOJiTqSLeyJt53Qs7Oe9sKYfU4XuX/zBFRVdSIgM/a/qRwJWMDWRr0D9676gk/5YD5aXtdyIWzv7kVDuikLkboU9H03x9u1DC/t7aJcButDGU6xWJAPYb06m/EFo5oU3NGBE1floU4eWA8vKOmHL/DiAegLcde0eDGHjahv0EbWXcyWZi2DoiQkUJPPHaqFFnKBjdoCQOSDFI2jL2wWLNUu57qH0FWVdUZa8wLOks99g==&buyer_id=2088722040528202&invoice_amount=290.00&notify_id=2026102701222181818128200510158949&fund_bill_list=[{"amount":"290.00","fundChannel":"ALIPAYACCOUNT"}]&notify_type=trade_status_sync&trade_status=TRADE_SUCCESS&receipt_amount=290.00&buyer_pay_amount=290.00&app_id=9021000140652602&sign_type=RSA2&seller_id=2088721043529665&gmt_payment=2026-10-27 18:18:17&notify_time=2026-10-27 18:18:18&version=1.0&out_trade_no=BWMVQJ82493A449B6E&total_amount=290.00&trade_no=2026102722001428200510238322&auth_app_id=9021000140652602&buyer_logon_id=djdnuw5864@sandbox.com&point_amount=0.00';

        expect(parseNotifyParams(rawBody)).toEqual({
            gmt_create: '2026-10-27 18:18:05',
            charset: 'utf-8',
            seller_email: 'mywesl5021@sandbox.com',
            subject: 'Beaconix plan order BWMVQJ82493A449B6E',
            sign: 'AkTMkGQyBE3sCl3ZuEev4Xq1lfg4DATSwMbX9HFYvyLJlujpXdQRamYWiKoZTadVLQ6yw3zMcYrxj/yHna7WJ5My+/o8JHMmzA0I9wFfeXsOJiTqSLeyJt53Qs7Oe9sKYfU4XuX/zBFRVdSIgM/a/qRwJWMDWRr0D9676gk/5YD5aXtdyIWzv7kVDuikLkboU9H03x9u1DC/t7aJcButDGU6xWJAPYb06m/EFo5oU3NGBE1floU4eWA8vKOmHL/DiAegLcde0eDGHjahv0EbWXcyWZi2DoiQkUJPPHaqFFnKBjdoCQOSDFI2jL2wWLNUu57qH0FWVdUZa8wLOks99g==',
            buyer_id: '2088722040528202',
            invoice_amount: '290.00',
            notify_id: '2026102701222181818128200510158949',
            fund_bill_list:
                '[{"amount":"290.00","fundChannel":"ALIPAYACCOUNT"}]',
            notify_type: 'trade_status_sync',
            trade_status: 'TRADE_SUCCESS',
            receipt_amount: '290.00',
            buyer_pay_amount: '290.00',
            app_id: '9021000140652602',
            sign_type: 'RSA2',
            seller_id: '2088721043529665',
            gmt_payment: '2026-10-27 18:18:17',
            notify_time: '2026-10-27 18:18:18',
            version: '1.0',
            out_trade_no: 'BWMVQJ82493A449B6E',
            total_amount: '290.00',
            trade_no: '2026102722001428200510238322',
            auth_app_id: '9021000140652602',
            buyer_logon_id: 'djdnuw5864@sandbox.com',
            point_amount: '0.00',
        });
    });

    it('parses the form-urlencoded body', () => {
        expect(
            parseNotifyParams('out_trade_no=BW1&trade_status=TRADE_SUCCESS'),
        ).toEqual({
            out_trade_no: 'BW1',
            trade_status: 'TRADE_SUCCESS',
        });
    });

    it('preserves empty values for the SDK to handle', () => {
        expect(parseNotifyParams('out_trade_no=BW1&buyer_id=&sign=x')).toEqual({
            out_trade_no: 'BW1',
            buyer_id: '',
            sign: 'x',
        });
    });

    it('decodes UTF-8, spaces and reserved characters exactly once', () => {
        expect(
            parseNotifyParams(
                'subject=%E8%AE%A2%E9%98%85+plan%20C%2B%2B%20%252B%20%25&passback_params=a%3Db%26c%3Dd',
            ),
        ).toEqual({
            subject: '订阅 plan C++ %2B %',
            passback_params: 'a=b&c=d',
        });
    });

    it.each([
        'qgaoKAba+JOYk/PXO/++nWxPE==',
        'qgaoKAba%2BJOYk%2FPXO%2F%2B%2BnWxPE%3D%3D',
        'qgaoKAba%2bJOYk%2fPXO%2f%2b%2bnWxPE%3d%3d',
        'qgaoKAba+JOYk%2FPXO/%2B+nWxPE=%3D',
    ])(
        'decodes the signature without changing literal plus signs: %s',
        (signature) => {
            expect(
                parseNotifyParams(`sign=${signature}&out_trade_no=BW1`),
            ).toEqual({
                sign: 'qgaoKAba+JOYk/PXO/++nWxPE==',
                out_trade_no: 'BW1',
            });
        },
    );

    it('decodes parameter names before applying signature rules', () => {
        expect(
            parseNotifyParams('%73ign=a+b%2Fc%3D&out%5Ftrade%5Fno=BW1'),
        ).toEqual({
            sign: 'a+b/c=',
            out_trade_no: 'BW1',
        });
    });

    it('returns an empty dictionary for an empty body', () => {
        expect(parseNotifyParams('')).toEqual({});
    });

    it('ignores empty segments and names but preserves valueless parameters', () => {
        expect(
            parseNotifyParams('&&=ignored&out_trade_no=BW1&&buyer_id&'),
        ).toEqual({
            out_trade_no: 'BW1',
            buyer_id: '',
        });
    });

    it('uses the last value for repeated decoded parameter names', () => {
        expect(
            parseNotifyParams('out_trade_no=BW1&out%5Ftrade_no=BW2'),
        ).toEqual({
            out_trade_no: 'BW2',
        });
    });

    it('keeps malformed percent escapes without throwing', () => {
        expect(
            parseNotifyParams('subject=100%+plan&sign=a+b%ZZ&%broken=value'),
        ).toEqual({
            subject: '100% plan',
            sign: 'a+b%ZZ',
            '%broken': 'value',
        });
    });

    it('stores prototype-like names as own properties', () => {
        const params = parseNotifyParams('__proto__=value&constructor=other');

        expect(Object.keys(params)).toEqual(['__proto__', 'constructor']);
        expect(params['__proto__']).toBe('value');
        expect(params['constructor']).toBe('other');
        expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
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
