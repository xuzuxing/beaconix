import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
    WechatConfig,
    WechatHttpConfig,
    WechatMiniProgramConfig,
    WechatOfficialAccountConfig,
    WechatPayConfig,
    WechatScanLoginConfig,
    WechatScanLoginEnvVersion,
    WechatVirtualPayConfig,
    WechatWebsiteConfig,
    WechatWorkConfig,
} from '../../config';
import { SettingsService } from '../../modules/settings';

/**
 * `wechat` 命名空间未注册时的兜底，取值与 `wechatConfig` 的内置默认一致，
 * 这样消费点不需要再判空。
 */
const EMPTY_WECHAT_CONFIG: WechatConfig = {
    pay: {
        mchId: '',
        appId: '',
        serialNo: '',
        privateKey: '',
        apiV3Key: '',
        notifyUrl: '',
        publicKey: '',
        publicKeyId: '',
        mock: true,
    },
    virtualPay: {
        offerId: '',
        appKey: '',
        sandboxAppKey: '',
        env: 0,
        pushToken: '',
        pushAesKey: '',
        mock: true,
    },
    miniprogram: { appId: '', appSecret: '' },
    website: { appId: '', appSecret: '' },
    scanLogin: {
        qrPage: '',
        qrEnvVersion: 'release',
        ttlSeconds: 300,
        pollTimeoutMs: 25000,
    },
    officialAccount: { appId: '', appSecret: '', token: '', aesKey: '' },
    work: { corpId: '', corpSecret: '', agentId: '' },
    http: { timeoutMs: 8000, maxRetries: 2 },
};

/** 微信只在 `develop` 上认这个值，但调用方常写 `developer`。 */
function scanLoginEnvVersion(value: string): WechatScanLoginEnvVersion {
    return value === 'developer'
        ? 'develop'
        : (value as WechatScanLoginEnvVersion);
}

/**
 * 微信配置的运行时视图：**管理页覆盖过的值优先，否则回退环境变量**。
 *
 * 管理与运营需要在后台改 AppID、回调地址、扫码登录参数而不重启服务，但密钥
 * 类配置历史上都放在 `.env` 里，直接改成「只读 DB」会让既有部署静默失效。
 * 所以这里的合并规则是：
 *
 * - 该 key 在 `settings` 表里被管理页改过（`overridden = true`）且值可用 → 用 DB；
 * - 否则（从未改过 / 改成了空字符串 / 值类型不对）→ 用环境变量；
 * - 环境变量也没有 → 用内置默认。
 *
 * 值按 key 单独缓存 30 秒（复用 `SettingsService` 的缓存窗口），所以后台改完
 * 最多 30 秒生效，不需要重启。唯一例外是 `http.*`：它在启动时用于构造单例
 * `WechatHttpClient`，改动需重启。
 */
@Injectable()
export class WechatRuntimeConfigService {
    constructor(
        private readonly settings: SettingsService,
        private readonly configService: ConfigService,
    ) {}

    async config(): Promise<WechatConfig> {
        const [
            pay,
            virtualPay,
            miniprogram,
            website,
            scanLogin,
            officialAccount,
            work,
            http,
        ] = await Promise.all([
            this.pay(),
            this.virtualPay(),
            this.miniprogram(),
            this.website(),
            this.scanLogin(),
            this.officialAccount(),
            this.work(),
            this.http(),
        ]);

        return {
            pay,
            virtualPay,
            miniprogram,
            website,
            scanLogin,
            officialAccount,
            work,
            http,
        };
    }

    async pay(): Promise<WechatPayConfig> {
        const env = this.env().pay;
        const [
            mchId,
            appId,
            serialNo,
            privateKey,
            apiV3Key,
            notifyUrl,
            publicKey,
            publicKeyId,
            mock,
        ] = await Promise.all([
            this.text('wechat.pay.mchId', env.mchId),
            this.text('wechat.pay.appId', env.appId),
            this.text('wechat.pay.serialNo', env.serialNo),
            this.text('wechat.pay.privateKey', env.privateKey),
            this.text('wechat.pay.apiV3Key', env.apiV3Key),
            this.text('wechat.pay.notifyUrl', env.notifyUrl),
            this.text('wechat.pay.publicKey', env.publicKey),
            this.text('wechat.pay.publicKeyId', env.publicKeyId),
            this.flag('wechat.pay.mock', env.mock),
        ]);

        return {
            mchId,
            appId,
            serialNo,
            privateKey,
            apiV3Key,
            notifyUrl,
            publicKey,
            publicKeyId,
            mock,
        };
    }

    async virtualPay(): Promise<WechatVirtualPayConfig> {
        const env = this.env().virtualPay;
        const [
            offerId,
            appKey,
            sandboxAppKey,
            envFlag,
            pushToken,
            pushAesKey,
            mock,
        ] = await Promise.all([
            this.text('wechat.virtualPay.offerId', env.offerId),
            this.text('wechat.virtualPay.appKey', env.appKey),
            this.text('wechat.virtualPay.sandboxAppKey', env.sandboxAppKey),
            this.integer('wechat.virtualPay.env', env.env),
            this.text('wechat.virtualPay.pushToken', env.pushToken),
            this.text('wechat.virtualPay.pushAesKey', env.pushAesKey),
            this.flag('wechat.virtualPay.mock', env.mock),
        ]);

        return {
            offerId,
            appKey,
            sandboxAppKey,
            // 现网只认 0：写成别的值（例如把沙箱当现网）会让每一笔下单都报 -15011。
            env: envFlag === 1 ? 1 : 0,
            pushToken,
            pushAesKey,
            mock,
        };
    }

    async miniprogram(): Promise<WechatMiniProgramConfig> {
        const env = this.env().miniprogram;
        const [appId, appSecret] = await Promise.all([
            this.text('wechat.miniprogram.appId', env.appId),
            this.text('wechat.miniprogram.appSecret', env.appSecret),
        ]);

        return { appId, appSecret };
    }

    async website(): Promise<WechatWebsiteConfig> {
        const env = this.env().website;
        const [appId, appSecret] = await Promise.all([
            this.text('wechat.website.appId', env.appId),
            this.text('wechat.website.appSecret', env.appSecret),
        ]);

        return { appId, appSecret };
    }

    async scanLogin(): Promise<WechatScanLoginConfig> {
        const env = this.env().scanLogin;
        const [qrPage, envVersion, ttlSeconds, pollTimeoutMs] =
            await Promise.all([
                this.text('wechat.scanLogin.page', env.qrPage),
                this.text('wechat.scanLogin.envVersion', env.qrEnvVersion),
                this.integer('wechat.scanLogin.ttlSeconds', env.ttlSeconds),
                this.integer(
                    'wechat.scanLogin.pollTimeoutMs',
                    env.pollTimeoutMs,
                ),
            ]);

        return {
            qrPage,
            qrEnvVersion: scanLoginEnvVersion(envVersion),
            ttlSeconds,
            pollTimeoutMs,
        };
    }

    async officialAccount(): Promise<WechatOfficialAccountConfig> {
        const env = this.env().officialAccount;
        const [appId, appSecret, token, aesKey] = await Promise.all([
            this.text('wechat.officialAccount.appId', env.appId),
            this.text('wechat.officialAccount.appSecret', env.appSecret),
            this.text('wechat.officialAccount.token', env.token),
            this.text('wechat.officialAccount.aesKey', env.aesKey),
        ]);

        return { appId, appSecret, token, aesKey };
    }

    async work(): Promise<WechatWorkConfig> {
        const env = this.env().work;
        const [corpId, corpSecret, agentId] = await Promise.all([
            this.text('wechat.work.corpId', env.corpId),
            this.text('wechat.work.corpSecret', env.corpSecret),
            this.text('wechat.work.agentId', env.agentId),
        ]);

        return { corpId, corpSecret, agentId };
    }

    async http(): Promise<WechatHttpConfig> {
        const env = this.env().http;
        const [timeoutMs, maxRetries] = await Promise.all([
            this.integer('wechat.http.timeoutMs', env.timeoutMs),
            this.integer('wechat.http.maxRetries', env.maxRetries),
        ]);

        return { timeoutMs, maxRetries };
    }

    // -- 合并规则 --------------------------------------------------------

    private env(): WechatConfig {
        return (
            this.configService.get<WechatConfig>('wechat') ??
            EMPTY_WECHAT_CONFIG
        );
    }

    /** 空白字符串视为「没配」，继续回退环境变量——证书/密钥粘贴时很容易带上换行。 */
    private async text(key: string, fallback: string): Promise<string> {
        const value = await this.settings.getOverriddenValue(key);
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed !== '') return trimmed;
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
            return value.toString();
        }

        return fallback;
    }

    private async integer(key: string, fallback: number): Promise<number> {
        const value = await this.settings.getOverriddenValue(key);
        const parsed =
            typeof value === 'number'
                ? value
                : typeof value === 'string'
                  ? this.parseNumber(value)
                  : Number.NaN;

        return Number.isFinite(parsed) ? parsed : fallback;
    }

    private async flag(key: string, fallback: boolean): Promise<boolean> {
        const value = await this.settings.getOverriddenValue(key);
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (['1', 'true', 'yes'].includes(normalized)) return true;
            if (['0', 'false', 'no'].includes(normalized)) return false;
        }

        return fallback;
    }

    private parseNumber(value: string): number {
        const normalized = value.trim();
        if (!/^\d+$/.test(normalized)) {
            return Number.NaN;
        }

        return Number(normalized);
    }
}
