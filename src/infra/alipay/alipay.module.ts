import { Global, Module } from '@nestjs/common';
import { SettingsModule } from '../../modules/settings';
import { AlipayClient } from './alipay.client';
import { AlipayRuntimeConfigService } from './alipay-runtime-config.service';

/**
 * 支付宝基础设施模块。
 *
 * - `AlipayRuntimeConfigService`：settings 表优先、env 兜底
 * - `AlipayClient`：官方 `alipay-sdk` 的薄封装（收银台 URL / 扫码预下单 / 验签）
 *
 * 全局注册，业务模块直接注入，不需要逐个 import。
 */
@Global()
@Module({
    imports: [SettingsModule],
    providers: [AlipayRuntimeConfigService, AlipayClient],
    exports: [AlipayRuntimeConfigService, AlipayClient],
})
export class AlipayModule {}
