import { Module } from '@nestjs/common';
import { SharedSubscriptionModule } from '../../../shared/subscription/subscription.module';
import { PaymentProviderModule } from '../payment/payment-provider.module';
import { RefundConfigService } from './refund-config.service';
import { RefundService } from './refund.service';

/**
 * 退款能力。`RefundService` 同时被用户端（P1）与后台（P0）使用，
 * 所以这里只装配，不挂 controller —— 入口分别在 `order.controller.ts` /
 * `payment.controller.ts` 与 `admin/refunds`。
 *
 * 依赖的 `PaymentProviderFactory` 来自 `PaymentProviderModule`：不能改成
 * import `BillingModule`，否则 `BillingModule → RefundModule → BillingModule` 成环。
 */
@Module({
    imports: [SharedSubscriptionModule, PaymentProviderModule],
    providers: [RefundService, RefundConfigService],
    exports: [RefundService, RefundConfigService],
})
export class RefundModule {}
