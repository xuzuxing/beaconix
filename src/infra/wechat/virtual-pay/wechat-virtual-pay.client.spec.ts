import { createHmac } from 'node:crypto';
import { WechatApiError } from '../wechat.types';
import { WechatVirtualPayClient } from './wechat-virtual-pay.client';
import type { WechatVirtualPayConfig } from '../../../config';
import { VIRTUAL_PAY_ORDER_STATUS } from './wechat-virtual-pay.types';

interface HttpClientMock {
    postRawJson: jest.Mock;
}

interface TokensMock {
    getAccessToken: jest.Mock;
    invalidate: jest.Mock;
}

function createClient(options?: {
    overrides?: Partial<WechatVirtualPayConfig>;
    http?: HttpClientMock;
    tokens?: TokensMock;
}) {
    const virtualPay: WechatVirtualPayConfig = {
        offerId: '1450000000',
        appKey: 'app-key-secret',
        sandboxAppKey: 'sandbox-key-secret',
        env: 0,
        pushToken: 'push-token',
        pushAesKey: '',
        mock: false,
        ...options?.overrides,
    };

    const http: HttpClientMock = options?.http ?? {
        postRawJson: jest.fn().mockResolvedValue({ errcode: 0 }),
    };
    const tokens: TokensMock = options?.tokens ?? {
        getAccessToken: jest.fn().mockResolvedValue('access-token-1'),
        invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const runtimeConfig = {
        virtualPay: jest.fn().mockResolvedValue(virtualPay),
        miniprogram: jest
            .fn()
            .mockResolvedValue({ appId: 'wx-app-id', appSecret: 'wx-secret' }),
    };

    const client = new WechatVirtualPayClient(
        http as never,
        tokens as never,
        runtimeConfig as never,
    );

    return { client, http, tokens, runtimeConfig };
}

describe('WechatVirtualPayClient', () => {
    it('signs payData with the AppKey and the user signature with the sessionKey', async () => {
        const { client } = createClient();

        const payData = await client.buildPayData({
            productId: 'beacon_pro_month',
            goodsPrice: 2900,
            outTradeNo: 'V1A2B3C4D5E6F7G8',
            attach: 'BWMB3KXABC123',
            sessionKey: 'session-key-value',
        });

        expect(payData.mode).toBe('short_series_goods');
        expect(payData.signData).toContain('"currencyType":"CNY"');
        expect(payData.signData).toContain('"env":0');
        expect(payData.paySig).toMatch(/^[0-9a-f]{64}$/);
        expect(payData.signature).toMatch(/^[0-9a-f]{64}$/);
        expect(payData.paySig).not.toBe(payData.signature);
    });

    it('uses the sandbox AppKey when env = 1', async () => {
        const production = createClient();
        const sandbox = createClient({ overrides: { env: 1 } });

        const input = {
            productId: 'p',
            goodsPrice: 1,
            outTradeNo: 'T1',
            attach: 'A1',
            sessionKey: 'sk',
        };

        const prod = await production.client.buildPayData(input);
        const sand = await sandbox.client.buildPayData(input);

        expect(sand.signData).toContain('"env":1');
        expect(sand.paySig).not.toBe(prod.paySig);
    });

    it('refuses env = 1 without a sandbox AppKey instead of falling back to the production key', async () => {
        const { client } = createClient({
            overrides: { env: 1, sandboxAppKey: '' },
        });

        await expect(
            client.buildPayData({
                productId: 'p',
                goodsPrice: 1,
                outTradeNo: 'T1',
                attach: 'A1',
                sessionKey: 'sk',
            }),
        ).rejects.toThrow(/sandbox AppKey/);
    });

    it('refuses to sign real payments without credentials', async () => {
        const { client } = createClient({
            overrides: { offerId: '', appKey: '' },
        });

        await expect(
            client.buildPayData({
                productId: 'p',
                goodsPrice: 1,
                outTradeNo: 'T1',
                attach: 'A1',
                sessionKey: 'sk',
            }),
        ).rejects.toThrow(/not configured/);
    });

    it('returns a structurally valid mock payData without credentials', async () => {
        const { client } = createClient({
            overrides: { offerId: '', appKey: '', mock: true },
        });

        const payData = await client.buildPayData({
            productId: 'p',
            goodsPrice: 1,
            outTradeNo: 'T1',
            attach: 'A1',
            sessionKey: 'sk',
        });

        expect(payData.paySig).toBe('mock_pay_sig_T1');
        expect(JSON.parse(payData.signData)).toMatchObject({
            offerId: '',
            productId: 'p',
            goodsPrice: 1,
            outTradeNo: 'T1',
            attach: 'A1',
        });
    });

    it('sends query_order with pay_sig computed over the exact body it posts', async () => {
        const http: HttpClientMock = {
            postRawJson: jest.fn().mockResolvedValue({
                errcode: 0,
                order: {
                    order_id: 'V1A2B3C4D5E6F7G8',
                    status: VIRTUAL_PAY_ORDER_STATUS.PAID,
                    order_fee: 2900,
                    paid_fee: 2900,
                    wx_order_id: 'wx_order_123456',
                    paid_time: 1700000100,
                    biz_meta: 'BWMB3KXABC123',
                },
            }),
        };
        const { client } = createClient({ http });

        const order = await client.queryOrder({
            openid: 'o_user_openid',
            outTradeNo: 'V1A2B3C4D5E6F7G8',
            env: 0,
        });

        expect(http.postRawJson).toHaveBeenCalledTimes(1);

        const [path, rawBody, requestOptions] = http.postRawJson.mock
            .calls[0] as [
            string,
            string,
            { query: { access_token: string; pay_sig: string } },
        ];

        expect(path).toBe('/xpay/query_order');
        expect(JSON.parse(rawBody)).toEqual({
            openid: 'o_user_openid',
            env: 0,
            order_id: 'V1A2B3C4D5E6F7G8',
        });
        expect(requestOptions.query.access_token).toBe('access-token-1');
        // 签名必须基于「实际发出的 body 原文」，路径不带 query
        expect(requestOptions.query.pay_sig).toMatch(/^[0-9a-f]{64}$/);

        const expected = createHmac('sha256', 'app-key-secret')
            .update(`/xpay/query_order&${rawBody}`, 'utf8')
            .digest('hex');
        expect(requestOptions.query.pay_sig).toBe(expected);

        expect(order).toMatchObject({
            orderId: 'V1A2B3C4D5E6F7G8',
            status: VIRTUAL_PAY_ORDER_STATUS.PAID,
            paidFee: 2900,
            wxOrderId: 'wx_order_123456',
            bizMeta: 'BWMB3KXABC123',
        });
    });

    it('treats mock query_order as unpaid so nothing is delivered by accident', async () => {
        const { client, http } = createClient({
            overrides: { mock: true },
        });

        const order = await client.queryOrder({
            openid: 'o_user_openid',
            outTradeNo: 'T1',
            env: 0,
        });

        expect(order.status).toBe(VIRTUAL_PAY_ORDER_STATUS.CREATED);
        expect(http.postRawJson).not.toHaveBeenCalled();
    });

    it('retries once with a fresh token when WeChat rejects the access token', async () => {
        const expired = new WechatApiError({
            platform: 'mp',
            endpoint: 'POST /xpay/query_order',
            errcode: 40001,
            errmsg: 'invalid credential',
        });
        const http: HttpClientMock = {
            postRawJson: jest
                .fn()
                .mockRejectedValueOnce(expired)
                .mockResolvedValueOnce({ errcode: 0, order: { status: 1 } }),
        };
        const tokens: TokensMock = {
            getAccessToken: jest
                .fn()
                .mockResolvedValueOnce('token-old')
                .mockResolvedValueOnce('token-new'),
            invalidate: jest.fn().mockResolvedValue(undefined),
        };
        const { client } = createClient({ http, tokens });

        await client.queryOrder({
            openid: 'o_user_openid',
            outTradeNo: 'T1',
            env: 0,
        });

        expect(tokens.invalidate).toHaveBeenCalledWith('mp', 'wx-app-id');
        expect(http.postRawJson).toHaveBeenCalledTimes(2);
        expect(
            (
                http.postRawJson.mock.calls[1] as [
                    string,
                    string,
                    { query: { access_token: string } },
                ]
            )[2].query.access_token,
        ).toBe('token-new');
    });
});
