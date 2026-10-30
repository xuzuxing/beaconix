import {
    Injectable,
    OnApplicationBootstrap,
    OnModuleDestroy,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../database/prisma.service';
import { MetricsService } from '../observability/metrics/metrics.service';
import { withTimeout } from '../../common/utils/with-timeout';
import {
    MONITOR_CHECK_QUEUE,
    MONITOR_SCAN_QUEUE,
} from '../../modules/checker/checker.queue';
import { NOTIFICATION_QUEUE } from '../../modules/notifier/notifier.queue';
import { SCHEDULED_JOBS_QUEUE } from './scheduled-jobs.constants';

/** Independent of BullMQ scheduling, so a stopped scheduler still yields fresh backlog samples. */
@Injectable()
export class SchedulerHealthCollector
    implements OnApplicationBootstrap, OnModuleDestroy
{
    private timer?: ReturnType<typeof setInterval>;
    private running = false;
    constructor(
        private readonly prisma: PrismaService,
        private readonly metrics: MetricsService,
        @InjectQueue(MONITOR_SCAN_QUEUE) private readonly scan: Queue,
        @InjectQueue(MONITOR_CHECK_QUEUE) private readonly check: Queue,
        @InjectQueue(SCHEDULED_JOBS_QUEUE) private readonly scheduled: Queue,
        @InjectQueue(NOTIFICATION_QUEUE) private readonly notification: Queue,
    ) {}

    onApplicationBootstrap(): void {
        void this.collect();
        this.timer = setInterval(() => {
            void this.collect();
        }, 15_000);
        this.timer.unref();
    }
    onModuleDestroy(): void {
        clearInterval(this.timer);
    }

    private failed(source: string) {
        try {
            this.metrics.recordSnapshot(source, false);
        } catch {
            /* Best effort. */
        }
    }

    async collect(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            await Promise.allSettled([
                ...(
                    [
                        [MONITOR_SCAN_QUEUE, this.scan],
                        [MONITOR_CHECK_QUEUE, this.check],
                        [SCHEDULED_JOBS_QUEUE, this.scheduled],
                        [NOTIFICATION_QUEUE, this.notification],
                    ] as [string, Queue][]
                ).map(async ([name, queue]) => {
                    try {
                        const counts = await withTimeout(
                            queue.getJobCounts(
                                'waiting',
                                'active',
                                'delayed',
                                'failed',
                            ),
                        );
                        this.metrics.setQueueSnapshot(name, counts);
                    } catch {
                        this.failed(`queue:${name}`);
                    }
                }),
                this.collectDatabase(),
            ]);
        } finally {
            this.running = false;
        }
    }

    private async collectDatabase(): Promise<void> {
        try {
            const rows = await withTimeout(this.prisma.$queryRaw<
                Array<{ source: string; count: number; age: number }>
            >`
                SELECT 'alert-deliveries' AS source, COUNT(*)::int AS count,
                    COALESCE(EXTRACT(EPOCH FROM now() - MIN("nextAttemptAt")), 0)::float8 AS age
                FROM alert_deliveries WHERE
                    (status = 'PENDING' AND "nextAttemptAt" <= now()) OR
                    (status IN ('QUEUED', 'SENDING') AND "leaseUntil" < now())
                UNION ALL
                SELECT 'workspace-notifications', COUNT(*)::int,
                    COALESCE(EXTRACT(EPOCH FROM now() - MIN("availableAt")), 0)::float8
                FROM notification_deliveries WHERE
                    (status = 'PENDING' AND "availableAt" <= now()) OR
                    (status = 'SENDING' AND "leaseUntil" < now())
                UNION ALL
                SELECT 'monitor-checks', COUNT(*)::int,
                    COALESCE(EXTRACT(EPOCH FROM now() - MIN(COALESCE(s."lastLocalCheckAt", m."createdAt") + m.interval * INTERVAL '1 second')), 0)::float8
                FROM monitors m LEFT JOIN monitor_states s ON s."monitorId" = m.id
                JOIN projects p ON p.id = m."projectId" AND p."deletedAt" IS NULL
                JOIN organizations o ON o.id = m."organizationId" AND o."deletedAt" IS NULL
                WHERE m.enabled AND m."deletedAt" IS NULL
                    AND (m."quotaGraceEndsAt" IS NULL OR m."quotaGraceEndsAt" > now())
                    AND (s."lastLocalCheckAt" IS NULL OR s."lastLocalCheckAt" < now() - m.interval * INTERVAL '1 second')
            `);
            for (const row of rows)
                this.metrics.setWorkBacklog(
                    row.source,
                    row.count,
                    Math.max(0, row.age),
                );
        } catch {
            for (const source of [
                'alert-deliveries',
                'workspace-notifications',
                'monitor-checks',
            ])
                this.failed(source);
        }
    }
}
