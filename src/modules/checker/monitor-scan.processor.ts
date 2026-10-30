import { Logger, Optional } from '@nestjs/common';
import { MetricsService } from '../../infra/observability/metrics/metrics.service';
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
        @Optional() private readonly metrics?: MetricsService,
    ) {
        super();
    }

    async process(): Promise<void> {
        this.observe('start');
        try {
            const { due, enqueued } =
                await this.checkerService.enqueueDueChecks(this.checkQueue);

            if (due > 0) {
                this.logger.log(`Queued ${enqueued}/${due} due monitor(s)`);
            }
            this.observe('success');
        } catch (error) {
            this.observe('failure');
            throw error;
        } finally {
            this.observe('complete');
        }
    }

    private observe(boundary: 'start' | 'success' | 'failure' | 'complete') {
        try {
            this.metrics?.recordSchedulerBoundary('monitor-scan', boundary);
        } catch {
            /* Best effort. */
        }
    }
}
