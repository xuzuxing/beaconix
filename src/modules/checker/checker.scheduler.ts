import {
    Injectable,
    Logger,
    OnModuleInit,
    OnModuleDestroy,
    Optional,
} from '@nestjs/common';
import { withTimeout } from '../../common/utils/with-timeout';
import { MetricsService } from '../../infra/observability/metrics/metrics.service';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
    MONITOR_SCAN_INTERVAL_MS,
    MONITOR_SCAN_JOB,
    MONITOR_SCAN_QUEUE,
    MONITOR_SCAN_SCHEDULER_ID,
} from './checker.queue';

/**
 * Registers the monitor-scan tick in BullMQ instead of running an in-process
 * cron job:
 *
 * - the schedule lives in Redis, so every replica does not run its own tick
 *   (which used to check the same monitors once per replica);
 * - the tick is a queued job, so a slow scan cannot pile up with the next one
 *   (the scan worker consumes it with `concurrency: 1`);
 * - re-registering on boot is idempotent (`upsertJobScheduler`).
 *
 * The scan itself only enqueues per-monitor check jobs; execution happens in
 * `MonitorCheckProcessor`.
 */
@Injectable()
export class CheckerScheduler implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(CheckerScheduler.name);
    private timer?: ReturnType<typeof setInterval>;
    private running = false;

    constructor(
        @InjectQueue(MONITOR_SCAN_QUEUE) private readonly scanQueue: Queue,
        @Optional() private readonly metrics?: MetricsService,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.reconcile();
        this.timer = setInterval(() => {
            void this.reconcile();
        }, 60_000);
        this.timer.unref();
    }

    onModuleDestroy(): void {
        clearInterval(this.timer);
    }

    private observe(success: boolean): void {
        try {
            this.metrics?.recordSchedulerRegistration('monitor-scan', success);
        } catch {
            /* Best effort. */
        }
    }

    async reconcile(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            const existing = await withTimeout(
                this.scanQueue.getJobScheduler(MONITOR_SCAN_SCHEDULER_ID),
            );
            if (
                !existing ||
                Number(existing.every) !== MONITOR_SCAN_INTERVAL_MS
            )
                await withTimeout(
                    this.scanQueue.upsertJobScheduler(
                        MONITOR_SCAN_SCHEDULER_ID,
                        { every: MONITOR_SCAN_INTERVAL_MS },
                        {
                            name: MONITOR_SCAN_JOB,
                            data: {},
                            opts: { removeOnComplete: true, removeOnFail: 100 },
                        },
                    ),
                );
            this.observe(true);

            this.logger.log(
                `Registered "${MONITOR_SCAN_SCHEDULER_ID}" every ${MONITOR_SCAN_INTERVAL_MS}ms`,
            );
        } catch (error) {
            this.observe(false);
            // Unlike the previous in-process cron, the tick depends on Redis:
            // log loudly instead of failing the whole application boot.
            this.logger.error(
                `Failed to register "${MONITOR_SCAN_SCHEDULER_ID}"; monitor scans will not run until Redis is reachable`,
                error as Error,
            );
        } finally {
            this.running = false;
        }
    }
}
