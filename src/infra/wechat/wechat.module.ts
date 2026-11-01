import { Global, Module } from '@nestjs/common';
import { WechatPayCertificateService, WechatPayClient } from './pay';
import { OfficialAccountClient } from './official-account';
import { WechatVirtualPayClient } from './virtual-pay';
import { WechatCoreModule } from './wechat-core.module';
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
    imports: [WechatCoreModule],
    providers: [
        WechatPayCertificateService,
        WechatPayClient,
        OfficialAccountClient,
        WechatVirtualPayClient,
        WorkClient,
    ],
    exports: [
        WechatCoreModule,
        WechatPayClient,
        OfficialAccountClient,
        WechatVirtualPayClient,
        WorkClient,
    ],
})
export class WechatModule {}
