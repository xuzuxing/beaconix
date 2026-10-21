import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PaymentProviderFactory } from './payment-provider.factory';
import { WechatVirtualPaymentService } from './wechat-virtual-payment.service';

/**
 * 把「只带退款能力」的渠道登记进工厂。
 *
 * 为什么不直接在 `PaymentProviderFactory` 构造器里注入虚拟支付：那会形成
 * `PaymentService → PaymentProviderFactory → WechatVirtualPaymentService →
 * PaymentService` 的循环依赖。改由这个独立的注册器在模块初始化时补登记，
 * 依赖边是单向的。
 */
@Injectable()
export class RefundProviderRegistrar implements OnModuleInit {
    constructor(
        private readonly factory: PaymentProviderFactory,
        private readonly virtualPay: WechatVirtualPaymentService,
    ) {}

    onModuleInit(): void {
        this.factory.registerRefundProvider(this.virtualPay);
    }
}
