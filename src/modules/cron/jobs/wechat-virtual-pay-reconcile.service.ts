import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ScheduledJobRegistry } from '../../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../../infra/scheduler/scheduled-jobs.constants';
import { WechatVirtualPaymentService } from '../../billing/payment/wechat-virtual-payment.service';

/**
 * 虚拟支付的兜底查单。
 *
 * 发货以平台推送为主，但推送可能丢（用户异常退出、网络抖动、平台重试耗尽），
 * 官方建议每 5 分钟用 `query_order` 查一次最近未支付的尝试并补发货。补发走
 * 与推送完全相同的结算入口，因此幂等行为一致（`wx_order_id` 去重）。
 */
@Injectable()
export class WechatVirtualPayReconcileService implements OnModuleInit {
    private readonly logger = new Logger(WechatVirtualPayReconcileService.name);

    constructor(
        private readonly registry: ScheduledJobRegistry,
        private readonly virtualPay: WechatVirtualPaymentService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.wechatVirtualPayReconcile,
            pattern:
                SCHEDULED_JOB_PATTERNS[
                    SCHEDULED_JOBS.wechatVirtualPayReconcile
                ],
            handler: () => this.handleReconcile(),
        });
    }

    async handleReconcile(): Promise<{ checked: number; settled: number }> {
        const result = await this.virtualPay.reconcilePendingAttempts();

        if (result.settled > 0) {
            this.logger.log(
                `Reconciled ${result.settled} paid virtual payment attempt(s) out of ${result.checked} checked`,
            );
        }

        return result;
    }
}
