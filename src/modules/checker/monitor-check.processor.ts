import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { CheckerService } from './checker.service';
import {
    MONITOR_CHECK_CONCURRENCY,
    MONITOR_CHECK_QUEUE,
} from './checker.queue';
import type { MonitorCheckJobData } from './checker.queue';

/**
 * Runs the local check of a single monitor. A failing check is logged and
 * swallowed: the next tick re-enqueues the monitor anyway (its state was never
 * updated), and one broken target must not block the rest of the queue.
 */
@Processor(MONITOR_CHECK_QUEUE, { concurrency: MONITOR_CHECK_CONCURRENCY })
export class MonitorCheckProcessor extends WorkerHost {
    private readonly logger = new Logger(MonitorCheckProcessor.name);

    constructor(private readonly checkerService: CheckerService) {
        super();
    }

    async process(job: Job<MonitorCheckJobData>): Promise<void> {
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
