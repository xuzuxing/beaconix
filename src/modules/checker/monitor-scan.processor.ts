import { Logger } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { CheckerService } from './checker.service';
import { MONITOR_CHECK_QUEUE, MONITOR_SCAN_QUEUE } from './checker.queue';
import type { MonitorCheckJobData } from './checker.queue';

/** Consumes the tick: looks up due monitors and fans out one job each. */
@Processor(MONITOR_SCAN_QUEUE, { concurrency: 1 })
export class MonitorScanProcessor extends WorkerHost {
    private readonly logger = new Logger(MonitorScanProcessor.name);

    constructor(
        private readonly checkerService: CheckerService,
        @InjectQueue(MONITOR_CHECK_QUEUE)
        private readonly checkQueue: Queue<MonitorCheckJobData>,
    ) {
        super();
    }

    async process(): Promise<void> {
        const { due, enqueued } = await this.checkerService.enqueueDueChecks(
            this.checkQueue,
        );

        if (due > 0) {
            this.logger.log(`Queued ${enqueued}/${due} due monitor(s)`);
        }
    }
}
