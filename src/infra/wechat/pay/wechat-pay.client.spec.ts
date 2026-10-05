import { createCipheriv, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { WechatPayConfig } from '../../../config';
import type { WechatHttpClient } from '../clients/wechat-http.client';
import { WechatApiError, WechatConfigurationError } from '../wechat.types';
import type { WechatPayCertificateService } from './wechat-pay-certificate.service';
import { WechatPayClient } from './wechat-pay.client';
import {
    buildResponseSignMessage,
    signMessage,
    verifyMessage,
} from './wechat-pay-signature.util';
import type {
    WechatPayEncryptedResource,
    WechatPayHeaderBag,
} from './wechat-pay.types';

const API_V3_KEY = '0123456789abcdef0123456789abcdef';
const NOTIFY_URL = 'https://beacon.example.com/api/payment/wechat/callback';

let privateKeyPem: string;
let publicKeyPem: string;

function encryptResource(
    plaintext: string,
    key = API_V3_KEY,
    associatedData = 'transaction',
): WechatPayEncryptedResource {
    const nonce = randomBytes(6).toString('hex');
    const cipher = createCipheriv(
        'aes-256-gcm',
        Buffer.from(key, 'utf8'),
        Buffer.from(nonce, 'utf8'),
    );
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));

    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
        algorithm: 'AEAD_AES_256_GCM',
        ciphertext: Buffer.concat([encrypted, tag]).toString('base64'),
        nonce,
        associated_data: associatedData,
    };
}

function createClient(overrides: Partial<WechatPayConfig> = {}) {
    const pay: WechatPayConfig = {
        mchId: 'mch-1',
        appId: 'wx-app-1',
        serialNo: 'SERIAL-1',
        privateKey: privateKeyPem,
        apiV3Key: API_V3_KEY,
        notifyUrl: NOTIFY_URL,
        publicKey: '',
        publicKeyId: '',
        mock: false,
        ...overrides,
    };

    const http = {
        request: jest.fn(),
        getJson: jest.fn(),
    };
    const certificates = {
        getVerifier: jest.fn().mockResolvedValue(publicKeyPem),
        refreshPlatformCertificates: jest.fn(),
    };
    const configService = {
        get: jest.fn().mockReturnValue({ pay }),
    };

    const client = new WechatPayClient(
        http as unknown as WechatHttpClient,
        certificates as unknown as WechatPayCertificateService,
        configService as unknown as ConfigService,
    );

    return { client, http, certificates, configService, pay };
}

function buildNotification(transaction: unknown): {
    body: string;
    headers: WechatPayHeaderBag;
} {
    const body = JSON.stringify({
        id: 'notify-1',
        create_time: new Date().toISOString(),
        event_type: 'TRANSACTION.SUCCESS',
        resource_type: 'encrypt-resource',
        resource: encryptResource(JSON.stringify(transaction)),
    });

    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(6).toString('hex');

    return {
        body,
        headers: {
            'wechatpay-timestamp': timestamp,
            'wechatpay-nonce': nonce,
            'wechatpay-signature': signMessage(
                buildResponseSignMessage(timestamp, nonce, body),
                privateKeyPem,
            ),
            'wechatpay-serial': 'SERIAL-1',
        },
    };
}

describe('WechatPayClient', () => {
    beforeAll(() => {
        const pair = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });

        privateKeyPem = pair.privateKey;
        publicKeyPem = pair.publicKey;
    });

    describe('createJsapiTransaction', () => {
        it('signs the request and returns the prepay id', async () => {
            const { client, http } = createClient();
            http.request.mockResolvedValue({ prepay_id: 'prepay-1' });

            const result = await client.createJsapiTransaction({
                description: 'Beacon plan order BW1',
                outTradeNo: 'BW1',
                totalFee: 100,
                openid: 'o_1',
            });

            expect(result).toEqual({ prepayId: 'prepay-1' });

            const [method, url, body, options] = http.request.mock.calls[0];
            expect(method).toBe('POST');
            expect(url).toBe(
                'https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi',
            );
            expect(body).toMatchObject({
                appid: 'wx-app-1',
                mchid: 'mch-1',
                description: 'Beacon plan order BW1',
                out_trade_no: 'BW1',
                notify_url: NOTIFY_URL,
                amount: { total: 100, currency: 'CNY' },
                payer: { openid: 'o_1' },
            });
            expect(options.headers.authorization).toMatch(
                /^WECHATPAY2-SHA256-RSA2048 /,
            );
            expect(options.platform).toBe('pay');
        });

        it('rejects when no notify url is configured', async () => {
            const { client } = createClient({ notifyUrl: '' });

            await expect(
                client.createJsapiTransaction({
                    description: 'order',
                    outTradeNo: 'BW1',
                    totalFee: 100,
                    openid: 'o_1',
                }),
            ).rejects.toThrow('WECHAT_PAY_NOTIFY_URL is required');
        });

        it('rejects when merchant credentials are missing', async () => {
            const { client } = createClient({ mchId: '' });

            await expect(
                client.createJsapiTransaction({
                    description: 'order',
                    outTradeNo: 'BW1',
                    totalFee: 100,
                    openid: 'o_1',
                }),
            ).rejects.toThrow(WechatConfigurationError);
        });
    });

    describe('buildJsapiPayParams', () => {
        it('returns wx.requestPayment params signed with the merchant key', () => {
            const { client } = createClient();

            const params = client.buildJsapiPayParams('prepay-1');

            expect(params.package).toBe('prepay_id=prepay-1');
            expect(params.signType).toBe('RSA');

            const message = `wx-app-1\n${params.timeStamp}\n${params.nonceStr}\n${params.package}\n`;
            expect(verifyMessage(message, params.paySign, publicKeyPem)).toBe(
                true,
            );
        });
    });

    describe('queryTransaction', () => {
        it('encodes the out-trade-no and signs the query string', async () => {
            const { client, http } = createClient();
            http.request.mockResolvedValue({ trade_state: 'SUCCESS' });

            await client.queryTransaction('BW/1?x');

            const [method, url] = http.request.mock.calls[0];
            expect(method).toBe('GET');
            expect(url).toBe(
                'https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/BW%2F1%3Fx?mchid=mch-1',
            );
        });
    });

    describe('parseNotification', () => {
        it('verifies the signature and decrypts the transaction', async () => {
            const { client, http, certificates } = createClient();
            http.request.mockResolvedValue({});

            const { body, headers } = buildNotification({
                out_trade_no: 'BW1',
                transaction_id: 'tx-1',
                trade_state: 'SUCCESS',
            });

            const transaction = await client.parseNotification(body, headers);

            expect(transaction).toMatchObject({
                out_trade_no: 'BW1',
                transaction_id: 'tx-1',
                trade_state: 'SUCCESS',
            });
            expect(certificates.getVerifier).toHaveBeenCalledWith('SERIAL-1');
        });

        it('rejects a payload without signature headers', async () => {
            const { client } = createClient();
            const { body, headers } = buildNotification({
                out_trade_no: 'BW1',
            });
            const incomplete = { ...headers };
            delete incomplete['wechatpay-nonce'];

            await expect(
                client.parseNotification(body, incomplete),
            ).rejects.toThrow('Missing WeChat Pay signature headers');
        });

        it('rejects a tampered body', async () => {
            const { client } = createClient();
            const { headers } = buildNotification({ out_trade_no: 'BW1' });
            const tampered = JSON.stringify({
                id: 'notify-1',
                resource_type: 'encrypt-resource',
                resource: encryptResource(JSON.stringify({ foo: 'bar' })),
            });

            await expect(
                client.parseNotification(tampered, headers),
            ).rejects.toThrow('signature verification failed');
        });

        it('rejects a stale timestamp', async () => {
            const { client } = createClient();
            const { body, headers } = buildNotification({
                out_trade_no: 'BW1',
            });
            const stale = String(Math.floor(Date.now() / 1000) - 3600);

            await expect(
                client.parseNotification(body, {
                    ...headers,
                    'wechatpay-timestamp': stale,
                }),
            ).rejects.toThrow(WechatApiError);
        });
    });

    describe('refreshPlatformCertificates', () => {
        it('delegates to the certificate service', async () => {
            const { client, certificates } = createClient();
            certificates.refreshPlatformCertificates.mockResolvedValue(2);

            await expect(client.refreshPlatformCertificates()).resolves.toBe(2);
        });
    });
});
