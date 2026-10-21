import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AlipayConfig } from '../../config';
import { AlipayClient } from './alipay.client';
import {
    AlipayApiError,
    AlipayConfigurationError,
    AlipayPayMethod,
} from './alipay.types';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const baseConfig: AlipayConfig = {
    appId: '2021000000000001',
    privateKey,
    publicKey,
    gateway: 'https://openapi.alipay.com/gateway.do',
    signType: 'RSA2',
    sandbox: false,
    notifyUrl: 'https://api.example.com/api/payment/alipay/callback',
    returnUrl: 'https://app.example.com/orders/BW123',
    mock: false,
};

function createClient(overrides: Partial<AlipayConfig> = {}) {
    const config: AlipayConfig = { ...baseConfig, ...overrides };
    const runtimeConfig = { config: jest.fn().mockResolvedValue(config) };
    const client = new AlipayClient(runtimeConfig as never);

    return { client, runtimeConfig, config };
}

/** 替换掉 SDK 实例，避免 precreate 真的打支付宝网关。 */
function stubSdk(
    client: AlipayClient,
    sdk: Record<string, jest.Mock>,
    config: AlipayConfig,
): void {
    jest.spyOn(
        client as unknown as { sdk: () => Promise<unknown> },
        'sdk',
    ).mockResolvedValue({ sdk, config });
}

const order = {
    outTradeNo: 'BW123',
    totalAmount: '9.99',
    subject: 'Beaconix plan order BW123',
};

describe('AlipayClient', () => {
    describe('buildCashierUrl', () => {
        it('signs a GET cashier URL for page.pay', async () => {
            const { client } = createClient();

            const url = new URL(await client.buildCashierUrl(order));

            expect(`${url.origin}${url.pathname}`).toBe(
                'https://openapi.alipay.com/gateway.do',
            );
            expect(url.searchParams.get('method')).toBe(AlipayPayMethod.PAGE);
            expect(url.searchParams.get('app_id')).toBe(baseConfig.appId);
            expect(url.searchParams.get('sign_type')).toBe('RSA2');
            expect(url.searchParams.get('sign')).toBeTruthy();
            expect(url.searchParams.get('notify_url')).toBe(
                baseConfig.notifyUrl,
            );
            expect(url.searchParams.get('return_url')).toBe(
                baseConfig.returnUrl,
            );
            expect(
                JSON.parse(url.searchParams.get('biz_content') ?? '{}'),
            ).toEqual({
                out_trade_no: order.outTradeNo,
                total_amount: order.totalAmount,
                subject: order.subject,
                // page.pay 必须带这个 product_code
                product_code: 'FAST_INSTANT_TRADE_PAY',
            });
        });

        it('uses the wap product code for the mobile cashier', async () => {
            const { client } = createClient();

            const url = new URL(await client.buildWapCashierUrl(order));

            expect(url.searchParams.get('method')).toBe(AlipayPayMethod.WAP);
            expect(
                JSON.parse(url.searchParams.get('biz_content') ?? '{}'),
            ).toMatchObject({ product_code: 'QUICK_WAP_WAY' });
        });

        it('switches to the sandbox gateway when sandbox is on', async () => {
            const { client } = createClient({ sandbox: true });

            const url = new URL(await client.buildCashierUrl(order));

            expect(url.host).toBe('openapi-sandbox.dl.alipaydev.com');
        });

        it('signs with SHA1 when signType is RSA', async () => {
            const { client } = createClient({ signType: 'RSA' });

            const url = new URL(await client.buildCashierUrl(order));

            expect(url.searchParams.get('sign_type')).toBe('RSA');
            expect(url.searchParams.get('sign')).toBeTruthy();
        });

        it('omits return_url when neither the request nor the config has one', async () => {
            const { client } = createClient({ returnUrl: '' });

            const url = new URL(await client.buildCashierUrl(order));

            expect(url.searchParams.has('return_url')).toBe(false);
        });

        it('prefers request URLs over the configured ones', async () => {
            const { client } = createClient();

            const url = new URL(
                await client.buildCashierUrl({
                    ...order,
                    notifyUrl: 'https://override.example.com/notify',
                    returnUrl: 'https://override.example.com/return',
                }),
            );

            expect(url.searchParams.get('notify_url')).toBe(
                'https://override.example.com/notify',
            );
            expect(url.searchParams.get('return_url')).toBe(
                'https://override.example.com/return',
            );
        });

        it('rejects a missing notify URL instead of creating an unverifiable order', async () => {
            const { client } = createClient({ notifyUrl: '' });

            await expect(client.buildCashierUrl(order)).rejects.toThrow(
                AlipayConfigurationError,
            );
        });

        it('rejects incomplete credentials', async () => {
            const { client: noAppId } = createClient({ appId: '' });
            await expect(noAppId.buildCashierUrl(order)).rejects.toThrow(
                /alipay\.appId is not configured/,
            );

            const { client: noKey } = createClient({ privateKey: '' });
            await expect(noKey.buildCashierUrl(order)).rejects.toThrow(
                /alipay\.privateKey is not configured/,
            );
        });

        it('reads the private key from a file path', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'alipay-key-'));
            const path = join(dir, 'app-private.pem');
            writeFileSync(path, privateKey, 'utf8');
            const { client } = createClient({ privateKey: path });

            const url = new URL(await client.buildCashierUrl(order));

            expect(url.searchParams.get('sign')).toBeTruthy();
        });
    });

    describe('precreate', () => {
        it('returns the QR payment link from the SDK', async () => {
            const { client, config } = createClient();
            const exec = jest.fn().mockResolvedValue({
                code: '10000',
                msg: 'Success',
                qrCode: 'https://qr.alipay.com/bax0123',
            });
            stubSdk(client, { exec }, config);

            const result = await client.precreate(order);

            expect(result).toEqual({ qrCode: 'https://qr.alipay.com/bax0123' });
            expect(exec).toHaveBeenCalledWith(AlipayPayMethod.PRECREATE, {
                bizContent: {
                    outTradeNo: order.outTradeNo,
                    totalAmount: order.totalAmount,
                    subject: order.subject,
                    productCode: 'FACE_TO_FACE_PAYMENT',
                },
                notifyUrl: baseConfig.notifyUrl,
            });
        });

        it('throws AlipayApiError when Alipay rejects the order', async () => {
            const { client, config } = createClient();
            const exec = jest.fn().mockResolvedValue({
                code: '40004',
                msg: 'Business Failed',
                subCode: 'ACQ.INVALID_PARAMETER',
                subMsg: 'total_amount is invalid',
            });
            stubSdk(client, { exec }, config);

            const error = await client.precreate(order).catch((e) => e);

            expect(error).toBeInstanceOf(AlipayApiError);
            expect(error.code).toBe('40004');
            expect(error.subCode).toBe('ACQ.INVALID_PARAMETER');
            expect(error.message).toContain('total_amount is invalid');
        });

        it('throws when Alipay reports success but returns no qr_code', async () => {
            const { client, config } = createClient();
            stubSdk(
                client,
                { exec: jest.fn().mockResolvedValue({ code: '10000' }) },
                config,
            );

            await expect(client.precreate(order)).rejects.toThrow(
                AlipayApiError,
            );
        });
    });

    describe('verifyNotify', () => {
        it('delegates the parameter dictionary to the SDK signature check', async () => {
            const { client, config } = createClient();
            const checkNotifySign = jest.fn().mockReturnValue(true);
            stubSdk(client, { checkNotifySign }, config);

            const params = {
                out_trade_no: 'BW123',
                trade_status: 'TRADE_SUCCESS',
                sign: 'sig',
                sign_type: 'RSA2',
            };

            await expect(client.verifyNotify(params)).resolves.toBe(true);
            expect(checkNotifySign).toHaveBeenCalledWith(params);
        });

        it('treats a throwing verifier as a failed signature', async () => {
            const { client, config } = createClient();
            const checkNotifySign = jest.fn().mockImplementation(() => {
                throw new Error('invalid key');
            });
            stubSdk(client, { checkNotifySign }, config);

            await expect(
                client.verifyNotify({ out_trade_no: 'BW123' }),
            ).resolves.toBe(false);
        });
    });
});
