import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AlipayConfig, AlipaySignType } from '../../config';
import { ALIPAY_PRODUCTION_GATEWAY } from '../../config';
import { SettingsService } from '../../modules/settings';

/**
 * `alipay` 命名空间未注册时的兜底，取值与 `alipayConfig` 的内置默认一致，
 * 这样消费点不需要再判空。
 */
const EMPTY_ALIPAY_CONFIG: AlipayConfig = {
    appId: '',
    privateKey: '',
    publicKey: '',
    gateway: ALIPAY_PRODUCTION_GATEWAY,
    signType: 'RSA2',
    sandbox: false,
    notifyUrl: '',
    returnUrl: '',
    mock: true,
};

/**
 * 支付宝配置的运行时视图：**管理页覆盖过的值优先，否则回退环境变量**。
 *
 * 与 `WechatRuntimeConfigService` 同一套合并规则：
 *
 * - 该 key 在 `settings` 表里被管理页改过（`overridden = true`）且值可用 → 用 DB；
 * - 否则（从未改过 / 改成了空字符串 / 值类型不对）→ 用环境变量；
 * - 环境变量也没有 → 用内置默认。
 *
 * 值按 key 单独缓存 30 秒（复用 `SettingsService` 的缓存窗口），所以后台改完
 * 最多 30 秒生效，不需要重启。紧急止血（把 `alipay.mock` 改回 true）也靠这条路径。
 */
@Injectable()
export class AlipayRuntimeConfigService {
    constructor(
        private readonly settings: SettingsService,
        private readonly configService: ConfigService,
    ) {}

    async config(): Promise<AlipayConfig> {
        const env = this.env();
        const [
            appId,
            privateKey,
            publicKey,
            gateway,
            signType,
            sandbox,
            notifyUrl,
            returnUrl,
            mock,
        ] = await Promise.all([
            this.text('alipay.appId', env.appId),
            this.text('alipay.privateKey', env.privateKey),
            this.text('alipay.publicKey', env.publicKey),
            this.text('alipay.gateway', env.gateway),
            this.signType('alipay.signType', env.signType),
            this.flag('alipay.sandbox', env.sandbox),
            this.text('alipay.notifyUrl', env.notifyUrl),
            this.text('alipay.returnUrl', env.returnUrl),
            this.flag('alipay.mock', env.mock),
        ]);

        return {
            appId,
            privateKey,
            publicKey,
            gateway,
            signType,
            sandbox,
            notifyUrl,
            returnUrl,
            mock,
        };
    }

    // -- 合并规则 --------------------------------------------------------

    private env(): AlipayConfig {
        return (
            this.configService.get<AlipayConfig>('alipay') ??
            EMPTY_ALIPAY_CONFIG
        );
    }

    /** 空白字符串视为「没配」，继续回退环境变量——密钥粘贴时很容易带上换行。 */
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

    private async signType(
        key: string,
        fallback: AlipaySignType,
    ): Promise<AlipaySignType> {
        const value = await this.text(key, fallback);

        return value.trim().toUpperCase() === 'RSA' ? 'RSA' : 'RSA2';
    }
}
