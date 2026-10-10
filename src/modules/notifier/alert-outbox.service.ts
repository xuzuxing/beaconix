import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../infra/database/prisma.service';
import { ScheduledJobRegistry } from '../../infra/scheduler/scheduled-job.registry';
import { NOTIFICATION_QUEUE, MONITOR_ALERT_EVENT_JOB } from './notifier.queue';
import type { NotificationJobData } from './notifier.queue';
import type { NotificationPayload } from './notifier.types';
import type { MonitorStatus } from '../../generated/prisma/enums';

@Injectable()
export class AlertOutboxService implements OnModuleInit {
    private readonly logger = new Logger(AlertOutboxService.name);
    constructor(
        private readonly prisma: PrismaService,
        private readonly registry: ScheduledJobRegistry,
        @InjectQueue(NOTIFICATION_QUEUE)
        private readonly queue: Queue<NotificationJobData>,
    ) {}

    onModuleInit() {
        this.registry.register({
            name: 'alert-outbox-sweep',
            pattern: '* * * * *',
            handler: () => this.dispatch(),
        });
    }

    async dispatch() {
        const now = new Date();
        const rows = await this.prisma.alertDelivery.findMany({
            where: {
                nextAttemptAt: { lte: now },
                OR: [
                    { status: 'PENDING' },
                    {
                        status: { in: ['QUEUED', 'SENDING'] },
                        leaseUntil: { lt: now },
                    },
                ],
            },
            orderBy: { nextAttemptAt: 'asc' },
            take: 100,
        });
        for (const row of rows) {
            const claim = await this.prisma.alertDelivery.updateMany({
                where: {
                    id: row.id,
                    status: row.status,
                    leaseUntil: row.leaseUntil,
                },
                data: {
                    status: 'QUEUED',
                    leaseToken: null,
                    leaseUntil: new Date(now.getTime() + 120_000),
                },
            });
            if (!claim.count) continue;
            const payload = row.payload as unknown as NotificationPayload;
            try {
                await this.queue.add(
                    MONITOR_ALERT_EVENT_JOB,
                    {
                        deliveryId: row.id,
                        channelId: row.channelId,
                        payload,
                        transitionStatus: payload.status as MonitorStatus,
                        sslAlert: false,
                    },
                    {
                        jobId: row.id,
                        attempts: 3,
                        backoff: { type: 'exponential', delay: 5000 },
                        removeOnComplete: true,
                        removeOnFail: true,
                    },
                );
            } catch (error) {
                await this.prisma.alertDelivery.updateMany({
                    where: { id: row.id, status: 'QUEUED' },
                    data: {
                        status: 'PENDING',
                        leaseUntil: null,
                        lastError: String(error),
                        nextAttemptAt: new Date(Date.now() + 5000),
                    },
                });
                this.logger.warn(`Outbox enqueue failed for ${row.id}`);
            }
        }
        return rows.length;
    }
}
