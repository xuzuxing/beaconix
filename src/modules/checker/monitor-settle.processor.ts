import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { CheckerService } from './checker.service';
import type { MonitorSettleJobData } from './checker.queue';

/**
 * Settles a batch whose window closed before every probe reported.
 *
 * BullMQ workers consume every job of their queue regardless of the job name, so
 * this consumer is deliberately not a second `@Processor` on
 * `MONITOR_CHECK_QUEUE`: `MonitorCheckProcessor` routes once-per-batch
 * `monitor-settle` jobs here. Two workers on the same queue would silently
 * swallow each other's jobs.
 *
 * A batch that already settled (all probes reported in time) resolves to
 * `DUPLICATE` and is a no-op.
 */
@Injectable()
export class MonitorSettleProcessor {
    private readonly logger = new Logger(MonitorSettleProcessor.name);

    constructor(private readonly checkerService: CheckerService) {}

    async handle(job: Job<MonitorSettleJobData>): Promise<void> {
        const { monitorId, roundId } = job.data;

        try {
            const result = await this.checkerService.settleRound(
                monitorId,
                roundId,
                { force: true },
            );
            if (result.outcome === 'SETTLED') {
                this.logger.log(
                    `Settled round ${roundId} of monitor ${monitorId} at its deadline`,
                );
            }
        } catch (error) {
            this.logger.warn(
                `Failed to settle round ${roundId} of monitor ${monitorId}: ${(error as Error).message}`,
            );
        }
    }
}
