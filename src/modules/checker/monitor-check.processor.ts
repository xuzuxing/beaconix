import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { CheckerService } from './checker.service';
import { MonitorSettleProcessor } from './monitor-settle.processor';
import {
    MONITOR_CHECK_CONCURRENCY,
    MONITOR_CHECK_JOB,
    MONITOR_CHECK_QUEUE,
    MONITOR_SETTLE_JOB,
} from './checker.queue';
import type {
    MonitorCheckJobData,
    MonitorSettleJobData,
} from './checker.queue';

/**
 * The worker of the check queue. It runs local checks and hands batch-deadline
 * jobs to `MonitorSettleProcessor`.
 *
 * A failing check is logged and swallowed: the next tick re-enqueues the monitor
 * anyway (its state was never updated), and one broken target must not block the
 * rest of the queue.
 */
@Processor(MONITOR_CHECK_QUEUE, { concurrency: MONITOR_CHECK_CONCURRENCY })
export class MonitorCheckProcessor extends WorkerHost {
    private readonly logger = new Logger(MonitorCheckProcessor.name);

    constructor(
        private readonly checkerService: CheckerService,
        private readonly settleProcessor: MonitorSettleProcessor,
    ) {
        super();
    }

    async process(
        job: Job<MonitorCheckJobData | MonitorSettleJobData>,
    ): Promise<void> {
        if (job.name === MONITOR_SETTLE_JOB) {
            await this.settleProcessor.handle(job as Job<MonitorSettleJobData>);
            return;
        }
        if (job.name !== MONITOR_CHECK_JOB) return;

        const { monitorId } = job.data;

        try {
            await this.checkerService.executeMonitor(monitorId);
        } catch (error) {
            this.logger.warn(
                `Check failed for monitor ${monitorId}: ${(error as Error).message}`,
            );
        }
    }
}
