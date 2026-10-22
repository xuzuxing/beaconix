import { Module } from '@nestjs/common';
import { AlipayPaymentService } from './alipay-payment.service';
import { PaymentProviderFactory } from './payment-provider.factory';
import { WechatPaymentService } from './wechat-payment.service';

/**
 * 渠道支付工厂的装配。
 *
 * 单独成模块的原因：`RefundService` 也要注入 `PaymentProviderFactory`，而
 * `RefundModule` 不能反向 import `BillingModule`（BillingModule 已经 import 了
 * RefundModule，会成环）。抽出来后由 `BillingModule` 与 `RefundModule` 共同
 * import，两边拿到的是同一个工厂实例 —— `RefundProviderRegistrar` 在
 * BillingModule 里做的虚拟支付补登记才对 RefundService 生效。
 *
 * 渠道客户端（WechatModule / AlipayModule）是全局模块，这里不需要重复 import。
 */
@Module({
    providers: [
        PaymentProviderFactory,
        WechatPaymentService,
        AlipayPaymentService,
    ],
    exports: [PaymentProviderFactory],
})
export class PaymentProviderModule {}
