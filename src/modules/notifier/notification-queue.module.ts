import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueModule, registerQueue } from '../../infra/queue/queue.module';
import { NOTIFICATION_QUEUE } from './notifier.queue';

/** One registration shared by the legacy app and notification runtime imports. */
@Module({
    imports: [QueueModule, registerQueue(NOTIFICATION_QUEUE)],
    exports: [BullModule],
})
export class NotificationQueueModule {}
