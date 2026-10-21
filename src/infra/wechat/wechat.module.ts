import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WechatConfig } from '../../config';
import { SettingsModule } from '../../modules/settings';
import { CacheModule } from '../cache/cache.module';
import {
    WECHAT_MP_BASE_URL,
    WechatHttpClient,
    WechatTokenService,
} from './clients';
import { WechatPayCertificateService, WechatPayClient } from './pay';
import { MiniprogramClient } from './miniprogram';
import { OfficialAccountClient } from './official-account';
import { WechatVirtualPayClient } from './virtual-pay';
import { WechatRuntimeConfigService } from './wechat-runtime-config.service';
import { WorkClient } from './work';

/**
 * WeChat infrastructure module.
 *
 * Provides the shared primitives used by every WeChat product sub-package
 * (pay / miniprogram / official-account / work):
 * - `WechatRuntimeConfigService`: platform settings first, env fallback
 * - `WechatHttpClient`: fetch + timeout + retry + error normalization
 * - `WechatTokenService`: access-token cache shared across instances
 * - `WechatPayClient`: WeChat Pay V3 signing, transactions and callbacks
 * - `MiniprogramClient`: code2Session, subscribe messages, phone number
 * - `OfficialAccountClient`: OAuth2, template/custom messages, safe-mode callbacks
 * - `WorkClient`: enterprise WeChat app messages and contact directory
 *
 * Registered globally so business modules can inject them without importing.
 */
@Global()
@Module({
    imports: [CacheModule, SettingsModule],
    providers: [
        WechatRuntimeConfigService,
        {
            provide: WechatHttpClient,
            useFactory: async (
                configService: ConfigService,
                runtimeConfig: WechatRuntimeConfigService,
            ) => {
                const env = configService.get<WechatConfig>('wechat');

                // 客户端是单例，超时/重试只在这里读一次：管理页改动需重启生效。
                // 读取失败（例如启动早期 DB 还不可用）不能让应用起不来，回退 env。
                let http = env?.http;
                try {
                    http = await runtimeConfig.http();
                } catch (error) {
                    new Logger(WechatModule.name).warn(
                        `Falling back to env for wechat.http settings: ${
                            error instanceof Error
                                ? error.message
                                : String(error)
                        }`,
                    );
                }

                return new WechatHttpClient({
                    platform: 'mp',
                    baseUrl: WECHAT_MP_BASE_URL,
                    timeoutMs: http?.timeoutMs,
                    maxRetries: http?.maxRetries,
                });
            },
            inject: [ConfigService, WechatRuntimeConfigService],
        },
        WechatTokenService,
        WechatPayCertificateService,
        WechatPayClient,
        MiniprogramClient,
        OfficialAccountClient,
        WechatVirtualPayClient,
        WorkClient,
    ],
    exports: [
        WechatRuntimeConfigService,
        WechatHttpClient,
        WechatTokenService,
        WechatPayClient,
        MiniprogramClient,
        OfficialAccountClient,
        WechatVirtualPayClient,
        WorkClient,
    ],
})
export class WechatModule {}
