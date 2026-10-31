import { Global, Module } from '@nestjs/common';
import { QueuesModule } from '../queue/queues.module';
import { ScheduledJobRegistry } from './scheduled-job.registry';
import { ScheduledJobsProcessor } from './scheduled-jobs.processor';
import { ScheduledJobsRegistrar } from './scheduled-jobs.registrar';
import { SchedulerHealthCollector } from './scheduler-health.collector';

/**
 * Owns the recurring-job plumbing: feature modules only register their handler
 * in `ScheduledJobRegistry`, this module takes care of the queue, the worker and
 * the schedule registration.
 */
@Global()
@Module({
    imports: [QueuesModule],
    providers: [
        ScheduledJobRegistry,
        ScheduledJobsProcessor,
        ScheduledJobsRegistrar,
        SchedulerHealthCollector,
    ],
    exports: [ScheduledJobRegistry],
})
export class ScheduledJobsModule {}
