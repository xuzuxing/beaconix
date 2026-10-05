import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WechatConfig } from '../../config';
import { CacheModule } from '../cache/cache.module';
import {
    WECHAT_MP_BASE_URL,
    WechatHttpClient,
    WechatTokenService,
} from './clients';
import { WechatPayCertificateService, WechatPayClient } from './pay';
import { MiniprogramClient } from './miniprogram';
import { OfficialAccountClient } from './official-account';
import { WorkClient } from './work';

/**
 * WeChat infrastructure module.
 *
 * Provides the shared primitives used by every WeChat product sub-package
 * (pay / miniprogram / official-account / work):
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
    imports: [CacheModule],
    providers: [
        {
            provide: WechatHttpClient,
            useFactory: (configService: ConfigService) => {
                const wechat = configService.get<WechatConfig>('wechat');

                return new WechatHttpClient({
                    platform: 'mp',
                    baseUrl: WECHAT_MP_BASE_URL,
                    timeoutMs: wechat?.http.timeoutMs,
                    maxRetries: wechat?.http.maxRetries,
                });
            },
            inject: [ConfigService],
        },
        WechatTokenService,
        WechatPayCertificateService,
        WechatPayClient,
        MiniprogramClient,
        OfficialAccountClient,
        WorkClient,
    ],
    exports: [
        WechatHttpClient,
        WechatTokenService,
        WechatPayClient,
        MiniprogramClient,
        OfficialAccountClient,
        WorkClient,
    ],
})
export class WechatModule {}
