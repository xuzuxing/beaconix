import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RefundStatus } from '../../../generated/prisma/enums';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ScheduledJobRegistry } from '../../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../../infra/scheduler/scheduled-jobs.constants';
import { RefundService } from '../../billing/refund/refund.service';

/** 渠道刚提交就查可能还没落账，留 10 分钟再兜底。 */
const STALE_AFTER_MS = 10 * 60 * 1000;
/** 一轮最多处理多少条，避免单次任务跑太久。 */
const BATCH_SIZE = 50;

/**
 * 退款兜底轮询。
 *
 * 微信以退款回调为主，支付宝**根本没有退款回调**，两者都可能因为网络丢失
 * 停在 `PROCESSING`。这里扫「提交超过 10 分钟还没终态」的记录，用渠道查询
 * 接口补一次；推进逻辑复用 `RefundService.syncFromChannel`，所以幂等与
 * 回调路径完全一致。
 */
@Injectable()
export class RefundReconcileService implements OnModuleInit {
    private readonly logger = new Logger(RefundReconcileService.name);

    constructor(
        private readonly registry: ScheduledJobRegistry,
        private readonly prisma: PrismaService,
        private readonly refunds: RefundService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.refundReconcile,
            pattern: SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.refundReconcile],
            handler: () => this.handleReconcile(),
        });
    }

    async handleReconcile(): Promise<{
        checked: number;
        settled: number;
        stillProcessing: number;
    }> {
        const stale = await this.prisma.refund.findMany({
            where: {
                status: RefundStatus.PROCESSING,
                submittedAt: { not: null },
                updatedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) },
            },
            select: { id: true },
            orderBy: { updatedAt: 'asc' },
            take: BATCH_SIZE,
        });

        let settled = 0;
        let stillProcessing = stale.length;

        for (const { id } of stale) {
            try {
                const refund = await this.refunds.syncFromChannel(id);

                if (refund.status === RefundStatus.SUCCESS) {
                    settled += 1;
                    stillProcessing -= 1;
                } else if (refund.status === RefundStatus.FAILED) {
                    stillProcessing -= 1;
                }
            } catch (error) {
                // 单条失败不影响其它记录；下一轮还会再试。
                this.logger.warn(
                    `Refund reconcile failed for ${id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

        if (settled > 0) {
            this.logger.log(
                `Reconciled ${settled} refund(s) out of ${stale.length} checked`,
            );
        }

        return { checked: stale.length, settled, stillProcessing };
    }
}
