import { Module } from '@nestjs/common';
import { WechatModule } from '../../infra/wechat/wechat.module';
import { SharedSubscriptionModule } from '../../shared/subscription/subscription.module';
import { QuotaModule } from '../../shared/quota/quota.module';
import { OrderController } from './order/order.controller';
import { OrderExpiryService } from './order/order-expiry.service';
import { OrderService } from './order/order.service';
import { PaymentController } from './payment/payment.controller';
import { PaymentProviderFactory } from './payment/payment-provider.factory';
import { PaymentService } from './payment/payment.service';
import { WechatPaymentService } from './payment/wechat-payment.service';
import { WechatVirtualPaymentService } from './payment/wechat-virtual-payment.service';
import { PlanController } from './plan/plan.controller';
import { PlanService } from './plan/plan.service';
import { QuotaController } from './quota/quota.controller';
import { SubscriptionController } from './subscription/subscription.controller';
import { SubscriptionExpiryService } from './subscription/subscription-expiry.service';
import { SubscriptionService } from './subscription/subscription.service';

@Module({
    imports: [SharedSubscriptionModule, QuotaModule, WechatModule],
    controllers: [
        PlanController,
        SubscriptionController,
        OrderController,
        PaymentController,
        QuotaController,
    ],
    providers: [
        PlanService,
        SubscriptionService,
        SubscriptionExpiryService,
        OrderService,
        OrderExpiryService,
        PaymentService,
        PaymentProviderFactory,
        WechatPaymentService,
        WechatVirtualPaymentService,
    ],
    exports: [
        PlanService,
        SubscriptionService,
        OrderService,
        PaymentService,
        WechatVirtualPaymentService,
    ],
})
export class BillingModule {}
