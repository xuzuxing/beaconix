import type { ConfigService } from '@nestjs/config';
import type { WechatPayClient } from '../../../infra/wechat/pay';
import { WechatPaymentService } from './wechat-payment.service';

function createService(mock: boolean) {
    const payClient = {
        createJsapiTransaction: jest.fn(),
        buildJsapiPayParams: jest.fn(),
        parseNotification: jest.fn(),
    };
    const configService = {
        get: jest.fn().mockReturnValue({ pay: { mock } }),
    };

    const service = new WechatPaymentService(
        payClient as unknown as WechatPayClient,
        configService as unknown as ConfigService,
    );

    return { service, payClient, configService };
}

describe('WechatPaymentService', () => {
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
});
