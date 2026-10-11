import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { StateService } from '../state/state.service';
import { NotifierService } from './notifier.service';
import { MONITOR_AVAILABILITY_JOB, NOTIFICATION_QUEUE } from './notifier.queue';
import type { NotificationJobData } from './notifier.queue';

@Processor(NOTIFICATION_QUEUE)
export class NotificationsProcessor extends WorkerHost {
    constructor(
        private readonly notifierService: NotifierService,
        private readonly stateService: StateService,
    ) {
        super();
    }

    async process(job: Job<NotificationJobData>): Promise<void> {
        if (job.data.deliveryId) {
            await this.notifierService.deliverAlertDelivery(
                job.data.deliveryId,
            );
            return;
        }
        const { channelId, payload, transitionStatus, sslAlert } = job.data;

        const delivered = await this.notifierService.deliver(
            channelId,
            payload,
        );
        if (delivered === false) return;

        // Availability alerts are a separate dimension from the status
        // transition, so they must not touch the transition dedup markers.
        if (job.name === MONITOR_AVAILABILITY_JOB) {
            return;
        }

        await this.stateService.markNotified(
            payload.monitorId,
            transitionStatus,
            payload.monitorRevision,
        );

        if (sslAlert) {
            await this.stateService.markSslNotified(
                payload.monitorId,
                undefined,
                payload.monitorRevision,
            );
        }
    }
}
