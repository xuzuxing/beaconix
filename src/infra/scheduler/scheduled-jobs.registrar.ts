import {
    Injectable,
    Logger,
    OnApplicationBootstrap,
    OnModuleDestroy,
    Optional,
} from '@nestjs/common';
import { MetricsService } from '../observability/metrics/metrics.service';
import { withTimeout } from '../../common/utils/with-timeout';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { SchedulerConfig } from '../../config';
import { ScheduledJobRegistry } from './scheduled-job.registry';
import { SCHEDULED_JOBS_QUEUE } from './scheduled-jobs.constants';

/**
 * Publishes the registered schedules to BullMQ.
 *
 * Runs on `onApplicationBootstrap` (after every module's `onModuleInit`, so all
 * handlers are registered) and uses `upsertJobScheduler`, which is idempotent -
 * replicas that boot later simply refresh the same schedule instead of adding
 * another one, so a job fires once per interval for the whole cluster.
 */
@Injectable()
export class ScheduledJobsRegistrar
    implements OnApplicationBootstrap, OnModuleDestroy
{
    private readonly logger = new Logger(ScheduledJobsRegistrar.name);
    private timer?: ReturnType<typeof setInterval>;
    private running = false;

    constructor(
        private readonly registry: ScheduledJobRegistry,
        @InjectQueue(SCHEDULED_JOBS_QUEUE) private readonly queue: Queue,
        private readonly configService: ConfigService,
        @Optional() private readonly metrics?: MetricsService,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        await this.reconcile();
        // Verify definitions periodically; upsert only missing/changed entries.
        // Re-upserting unchanged cron schedules can delete an overdue queued tick.
        this.timer = setInterval(() => {
            void this.reconcile();
        }, 60_000);
        this.timer.unref();
    }

    onModuleDestroy(): void {
        clearInterval(this.timer);
    }

    async reconcile(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            await this.registerDefinitions();
        } finally {
            this.running = false;
        }
    }

    private observe(name: string, success: boolean): void {
        try {
            this.metrics?.recordSchedulerRegistration(name, success);
        } catch {
            /* Best effort. */
        }
    }

    private async registerDefinitions(): Promise<void> {
        const definitions = this.registry.list();
        const defaultTimezone =
            this.configService.get<SchedulerConfig>('scheduler')?.timezone ??
            '';

        if (definitions.length === 0) {
            this.logger.warn('No scheduled jobs registered');
            return;
        }

        let registered = 0;

        for (const definition of definitions) {
            const timezone = definition.timezone ?? defaultTimezone;

            try {
                const existing = await withTimeout(
                    this.queue.getJobScheduler(definition.name),
                );
                if (
                    !existing ||
                    existing.pattern !== definition.pattern ||
                    (existing.tz ?? '') !== timezone
                )
                    await withTimeout(
                        this.queue.upsertJobScheduler(
                            definition.name,
                            {
                                pattern: definition.pattern,
                                ...(timezone ? { tz: timezone } : {}),
                            },
                            {
                                name: definition.name,
                                data: {},
                                opts: {
                                    removeOnComplete: true,
                                    removeOnFail: 100,
                                },
                            },
                        ),
                    );
                registered += 1;
                this.observe(definition.name, true);
            } catch (error) {
                this.observe(definition.name, false);
                // A missing schedule for one job must not stop the others.
                this.logger.error(
                    `Failed to register scheduled job "${definition.name}"`,
                    error as Error,
                );
            }
        }

        this.logger.log(
            `Registered ${registered}/${definitions.length} scheduled job(s): ` +
                definitions
                    .map(
                        (definition) =>
                            `${definition.name}@${definition.pattern}`,
                    )
                    .join(', '),
        );
    }
}
