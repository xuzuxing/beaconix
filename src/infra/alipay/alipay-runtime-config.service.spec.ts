import type { ConfigService } from '@nestjs/config';
import type { AlipayConfig } from '../../config';
import type { SettingsService } from '../../modules/settings';
import { AlipayRuntimeConfigService } from './alipay-runtime-config.service';

const ENV_CONFIG: AlipayConfig = {
    appId: 'app-env',
    privateKey: '-----BEGIN PRIVATE KEY-----\nenv\n-----END PRIVATE KEY-----',
    publicKey: '-----BEGIN PUBLIC KEY-----\nenv\n-----END PUBLIC KEY-----',
    gateway: 'https://env.example.com/gateway.do',
    signType: 'RSA',
    sandbox: true,
    notifyUrl: 'https://env.example.com/api/payment/alipay/callback',
    returnUrl: 'https://env.example.com/orders',
    mock: false,
};

function createService(
    overrides: Record<string, unknown> = {},
    env: AlipayConfig | null = ENV_CONFIG,
) {
    const settings = {
        getOverriddenValue: jest.fn((key: string) =>
            Promise.resolve(overrides[key]),
        ),
    };
    const configService = {
        get: jest.fn().mockReturnValue(env ?? undefined),
    };

    const service = new AlipayRuntimeConfigService(
        settings as unknown as SettingsService,
        configService as unknown as ConfigService,
    );

    return { service, settings };
}

describe('AlipayRuntimeConfigService', () => {
    it('falls back to the environment when nothing is overridden', async () => {
        const { service } = createService();

        await expect(service.config()).resolves.toEqual(ENV_CONFIG);
    });

    it('lets admin settings override the environment', async () => {
        const { service } = createService({
            'alipay.appId': 'app-db',
            'alipay.notifyUrl': 'https://db.example.com/notify',
            'alipay.sandbox': false,
            'alipay.mock': true,
        });

        const config = await service.config();

        expect(config.appId).toBe('app-db');
        expect(config.notifyUrl).toBe('https://db.example.com/notify');
        expect(config.sandbox).toBe(false);
        expect(config.mock).toBe(true);
        // untouched keys still come from the environment
        expect(config.privateKey).toBe(ENV_CONFIG.privateKey);
    });

    it('falls back to the environment when the override is blank', async () => {
        const { service } = createService({
            'alipay.appId': '',
            'alipay.privateKey': '   ',
            'alipay.returnUrl': '',
        });

        const config = await service.config();

        expect(config.appId).toBe(ENV_CONFIG.appId);
        expect(config.privateKey).toBe(ENV_CONFIG.privateKey);
        expect(config.returnUrl).toBe(ENV_CONFIG.returnUrl);
    });

    it('parses boolean overrides written as strings', async () => {
        const { service } = createService({
            'alipay.sandbox': 'true',
            'alipay.mock': 'false',
        });

        const config = await service.config();

        expect(config.sandbox).toBe(true);
        expect(config.mock).toBe(false);
    });

    it('normalises the sign type and defaults it to RSA2', async () => {
        const { service } = createService({
            'alipay.signType': 'rsa',
        });
        await expect(service.config()).resolves.toMatchObject({
            signType: 'RSA',
        });

        const { service: fallback } = createService({
            'alipay.signType': 'sha256',
        });
        await expect(fallback.config()).resolves.toMatchObject({
            signType: 'RSA2',
        });
    });

    it('keeps built-in defaults when neither DB nor env is configured', async () => {
        const { service } = createService({}, null);

        await expect(service.config()).resolves.toEqual({
            appId: '',
            privateKey: '',
            publicKey: '',
            gateway: 'https://openapi.alipay.com/gateway.do',
            signType: 'RSA2',
            sandbox: false,
            notifyUrl: '',
            returnUrl: '',
            // 无凭证时默认 mock，保证未接入支付宝的部署照样能跑通计费流程
            mock: true,
        });
    });
});
