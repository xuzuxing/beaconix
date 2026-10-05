import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { StateService } from '../state/state.service';
import { NotifierService } from './notifier.service';
import { NOTIFICATION_QUEUE } from './notifier.queue';
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
        const { channelId, payload, transitionStatus, sslAlert } = job.data;

        await this.notifierService.deliver(channelId, payload);

        await this.stateService.markNotified(
            payload.monitorId,
            transitionStatus,
        );

        if (sslAlert) {
            await this.stateService.markSslNotified(payload.monitorId);
        }
    }
}
