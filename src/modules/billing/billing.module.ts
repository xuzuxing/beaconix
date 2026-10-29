import { Module } from '@nestjs/common';
import { AlipayModule } from '../../infra/alipay';
import { WechatModule } from '../../infra/wechat/wechat.module';
import { SharedSubscriptionModule } from '../../shared/subscription/subscription.module';
import { QuotaModule } from '../../shared/quota/quota.module';
import { OrderController } from './order/order.controller';
import { OrderExpiryService } from './order/order-expiry.service';
import { OrderService } from './order/order.service';
import { PaymentController } from './payment/payment.controller';
import { PaymentProviderModule } from './payment/payment-provider.module';
import { RefundProviderRegistrar } from './payment/refund-provider.registrar';
import { PaymentService } from './payment/payment.service';
import { WechatVirtualPaymentService } from './payment/wechat-virtual-payment.service';
import { PlanController } from './plan/plan.controller';
import { PlanService } from './plan/plan.service';
import { QuotaController } from './quota/quota.controller';
import { RefundModule } from './refund/refund.module';
import { SubscriptionController } from './subscription/subscription.controller';
import { SubscriptionExpiryService } from './subscription/subscription-expiry.service';
import { SubscriptionService } from './subscription/subscription.service';
import { MonitorCapacityController } from './subscription/monitor-capacity.controller';
import { BillingMonitorCapacityService } from './subscription/monitor-capacity.service';
import { AuthorizationModule } from '../../common/authorization/authorization.module';

@Module({
    imports: [
        AuthorizationModule,
        SharedSubscriptionModule,
        QuotaModule,
        WechatModule,
        AlipayModule,
        // 渠道工厂（含微信/支付宝下单能力）单独成模块，RefundModule 也要用。
        PaymentProviderModule,
        RefundModule,
    ],
    controllers: [
        MonitorCapacityController,
        PlanController,
        SubscriptionController,
        OrderController,
        PaymentController,
        QuotaController,
    ],
    providers: [
        BillingMonitorCapacityService,
        PlanService,
        SubscriptionService,
        SubscriptionExpiryService,
        OrderService,
        OrderExpiryService,
        PaymentService,
        RefundProviderRegistrar,
        WechatVirtualPaymentService,
    ],
    exports: [
        SharedSubscriptionModule,
        PlanService,
        SubscriptionService,
        OrderService,
        PaymentService,
        WechatVirtualPaymentService,
        // RefundService 由 RefundModule 提供，这里转发导出该模块，
        // 让 admin / cron 仍能通过 BillingModule 拿到退款能力。
        RefundModule,
    ],
})
export class BillingModule {}
