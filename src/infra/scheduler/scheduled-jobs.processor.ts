import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ScheduledJobRegistry } from './scheduled-job.registry';
import { SCHEDULED_JOBS_QUEUE } from './scheduled-jobs.constants';

/**
 * Runs the scheduled jobs one at a time.
 *
 * `concurrency: 1` is deliberate: BullMQ's job scheduler keeps producing jobs
 * even while the previous one still runs, so a single slot both prevents the
 * same job from overlapping itself and keeps the (light) handlers serialised.
 */
@Processor(SCHEDULED_JOBS_QUEUE, { concurrency: 1 })
export class ScheduledJobsProcessor extends WorkerHost {
    private readonly logger = new Logger(ScheduledJobsProcessor.name);

    constructor(private readonly registry: ScheduledJobRegistry) {
        super();
    }

    async process(job: Job): Promise<void> {
        const definition = this.registry.get(job.name);

        if (!definition) {
            this.logger.warn(
                `No handler registered for scheduled job "${job.name}"; skipping`,
            );
            return;
        }

        // Errors propagate on purpose: a failed run lands in the failed set and
        // shows up in the scheduler health endpoint.
        await definition.handler();
    }
}
