import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WechatConfig } from '../../config';
import { SettingsCoreModule } from '../../modules/settings/settings-core.module';
import { CacheModule } from '../cache/cache.module';
import {
    WECHAT_MP_BASE_URL,
    WechatHttpClient,
    WechatTokenService,
} from './clients';
import { MiniprogramClient } from './miniprogram';
import { WechatRuntimeConfigService } from './wechat-runtime-config.service';

/** Shared message transport; does not install payment clients or HTTP routes. */
@Module({
    imports: [CacheModule, SettingsCoreModule],
    providers: [
        WechatRuntimeConfigService,
        {
            provide: WechatHttpClient,
            useFactory: async (
                configService: ConfigService,
                runtimeConfig: WechatRuntimeConfigService,
            ) => {
                const env = configService.get<WechatConfig>('wechat');

                // HTTP settings are read once; changes still require restart.
                let http = env?.http;
                try {
                    http = await runtimeConfig.http();
                } catch (error) {
                    new Logger(WechatCoreModule.name).warn(
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
        MiniprogramClient,
    ],
    exports: [
        WechatRuntimeConfigService,
        WechatHttpClient,
        WechatTokenService,
        MiniprogramClient,
    ],
})
export class WechatCoreModule {}
