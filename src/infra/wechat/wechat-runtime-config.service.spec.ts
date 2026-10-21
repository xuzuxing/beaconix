import type { ConfigService } from '@nestjs/config';
import type { WechatConfig } from '../../config';
import type { SettingsService } from '../../modules/settings';
import { WechatRuntimeConfigService } from './wechat-runtime-config.service';

const ENV_CONFIG: WechatConfig = {
    pay: {
        mchId: 'mch-env',
        appId: 'wx-pay-env',
        serialNo: 'SERIAL-ENV',
        privateKey:
            '-----BEGIN PRIVATE KEY-----\nenv\n-----END PRIVATE KEY-----',
        apiV3Key: 'apiv3-env',
        notifyUrl: 'https://env.example.com/notify',
        publicKey: '-----BEGIN PUBLIC KEY-----\nenv\n-----END PUBLIC KEY-----',
        publicKeyId: 'PUB_KEY_ID_ENV',
        mock: false,
    },
    virtualPay: {
        offerId: 'offer-env',
        appKey: 'vp-appkey-env',
        sandboxAppKey: 'vp-sandbox-env',
        env: 0,
        pushToken: 'vp-push-token-env',
        pushAesKey: 'vp-push-aes-env',
        mock: false,
    },
    miniprogram: { appId: 'wx-mp-env', appSecret: 'mp-secret-env' },
    website: { appId: 'wx-web-env', appSecret: 'web-secret-env' },
    scanLogin: {
        qrPage: 'pages/env',
        qrEnvVersion: 'release',
        ttlSeconds: 300,
        pollTimeoutMs: 25000,
    },
    officialAccount: {
        appId: 'wx-oa-env',
        appSecret: 'oa-secret-env',
        token: 'OA_TOKEN_ENV',
        aesKey: 'OA_AES_ENV',
    },
    work: {
        corpId: 'corp-env',
        corpSecret: 'corp-secret-env',
        agentId: '100001',
    },
    http: { timeoutMs: 8000, maxRetries: 2 },
};

function createService(
    overrides: Record<string, unknown> = {},
    env: WechatConfig | null = ENV_CONFIG,
) {
    const settings = {
        getOverriddenValue: jest.fn((key: string) =>
            Promise.resolve(overrides[key]),
        ),
    };
    const configService = {
        get: jest.fn().mockReturnValue(env ?? undefined),
    };

    const service = new WechatRuntimeConfigService(
        settings as unknown as SettingsService,
        configService as unknown as ConfigService,
    );

    return { service, settings };
}

describe('WechatRuntimeConfigService', () => {
    it('falls back to the environment when nothing is overridden', async () => {
        const { service } = createService();

        await expect(service.pay()).resolves.toEqual(ENV_CONFIG.pay);
        await expect(service.miniprogram()).resolves.toEqual(
            ENV_CONFIG.miniprogram,
        );
        await expect(service.website()).resolves.toEqual(ENV_CONFIG.website);
        await expect(service.scanLogin()).resolves.toEqual(
            ENV_CONFIG.scanLogin,
        );
        await expect(service.officialAccount()).resolves.toEqual(
            ENV_CONFIG.officialAccount,
        );
        await expect(service.work()).resolves.toEqual(ENV_CONFIG.work);
        await expect(service.http()).resolves.toEqual(ENV_CONFIG.http);
    });

    it('prefers the value saved on the admin page', async () => {
        const { service } = createService({
            'wechat.pay.mchId': 'mch-db',
            'wechat.miniprogram.appId': 'wx-mp-db',
            'wechat.work.agentId': '200002',
        });

        await expect(service.pay()).resolves.toMatchObject({ mchId: 'mch-db' });
        await expect(service.miniprogram()).resolves.toMatchObject({
            appId: 'wx-mp-db',
        });
        await expect(service.work()).resolves.toMatchObject({
            agentId: '200002',
        });
    });

    it('treats a blank stored value as "not configured"', async () => {
        const { service } = createService({
            'wechat.pay.mchId': '   ',
            'wechat.miniprogram.appSecret': '',
        });

        await expect(service.pay()).resolves.toMatchObject({
            mchId: ENV_CONFIG.pay.mchId,
        });
        await expect(service.miniprogram()).resolves.toMatchObject({
            appSecret: ENV_CONFIG.miniprogram.appSecret,
        });
    });

    it('trims a pasted certificate', async () => {
        const { service } = createService({
            'wechat.pay.privateKey':
                '\n  -----BEGIN PRIVATE KEY-----\ndb\n-----END PRIVATE KEY-----\n',
        });

        await expect(service.pay()).resolves.toMatchObject({
            privateKey:
                '-----BEGIN PRIVATE KEY-----\ndb\n-----END PRIVATE KEY-----',
        });
    });

    it('keeps a stored false for the mock flag', async () => {
        const { service: mocked } = createService({
            'wechat.pay.mock': true,
        });
        const { service: live } = createService({
            'wechat.pay.mock': false,
        });

        await expect(mocked.pay()).resolves.toMatchObject({ mock: true });
        await expect(live.pay()).resolves.toMatchObject({ mock: false });
    });

    it('parses numeric overrides and ignores unusable ones', async () => {
        const { service } = createService({
            'wechat.scanLogin.ttlSeconds': '600',
            'wechat.scanLogin.pollTimeoutMs': 'soon',
            'wechat.http.maxRetries': 4,
            'wechat.http.timeoutMs': 'abc',
        });

        await expect(service.scanLogin()).resolves.toMatchObject({
            ttlSeconds: 600,
            pollTimeoutMs: ENV_CONFIG.scanLogin.pollTimeoutMs,
        });
        await expect(service.http()).resolves.toEqual({
            timeoutMs: ENV_CONFIG.http.timeoutMs,
            maxRetries: 4,
        });
    });

    it('normalises the legacy "developer" env version', async () => {
        const { service } = createService({
            'wechat.scanLogin.envVersion': 'developer',
        });

        await expect(service.scanLogin()).resolves.toMatchObject({
            qrEnvVersion: 'develop',
        });
    });

    it('falls back to built-in defaults when the wechat namespace is missing', async () => {
        const { service } = createService({}, null);

        await expect(service.pay()).resolves.toMatchObject({
            mchId: '',
            mock: true,
        });
        await expect(service.scanLogin()).resolves.toEqual({
            qrPage: '',
            qrEnvVersion: 'release',
            ttlSeconds: 300,
            pollTimeoutMs: 25000,
        });
        await expect(service.http()).resolves.toEqual({
            timeoutMs: 8000,
            maxRetries: 2,
        });
    });

    it('reads every key it exposes from the settings table', async () => {
        const { service, settings } = createService();

        await service.config();

        const keys = settings.getOverriddenValue.mock.calls.map(([key]) => key);

        expect(keys).toHaveLength(33);
        expect(new Set(keys).size).toBe(33);
        expect(keys).toEqual(
            expect.arrayContaining([
                'wechat.pay.mchId',
                'wechat.pay.mock',
                'wechat.miniprogram.appId',
                'wechat.website.appSecret',
                'wechat.scanLogin.page',
                'wechat.officialAccount.aesKey',
                'wechat.work.agentId',
                'wechat.http.timeoutMs',
                'wechat.virtualPay.offerId',
                'wechat.virtualPay.appKey',
                'wechat.virtualPay.sandboxAppKey',
                'wechat.virtualPay.env',
                'wechat.virtualPay.pushToken',
                'wechat.virtualPay.pushAesKey',
                'wechat.virtualPay.mock',
            ]),
        );
    });
});
