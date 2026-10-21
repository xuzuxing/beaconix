import { Module } from '@nestjs/common';
import { SharedSubscriptionModule } from '../../../shared/subscription/subscription.module';
import { RefundConfigService } from './refund-config.service';
import { RefundService } from './refund.service';

/**
 * 退款能力。`RefundService` 同时被用户端（P1）与后台（P0）使用，
 * 所以这里只装配，不挂 controller —— 入口分别在 `refund.controller.ts`
 * 与 `admin/refunds`。
 */
@Module({
    imports: [SharedSubscriptionModule],
    providers: [RefundService, RefundConfigService],
    exports: [RefundService, RefundConfigService],
})
export class RefundModule {}
