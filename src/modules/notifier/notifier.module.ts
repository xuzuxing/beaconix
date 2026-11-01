import { Module } from '@nestjs/common';
import { QueuesModule } from '../../infra/queue/queues.module';
import { StateModule } from '../state/state.module';
import { NotificationChannelsController } from './notification-channels.controller';
import { NotificationChannelsService } from './notification-channels.service';
import { NotificationsProcessor } from './notifications.processor';
import { NotifierCoreModule } from './notifier-core.module';
import { AlertOutboxService } from './alert-outbox.service';

@Module({
    imports: [StateModule, NotifierCoreModule, QueuesModule],
    controllers: [NotificationChannelsController],
    providers: [
        NotificationChannelsService,
        AlertOutboxService,
        NotificationsProcessor,
    ],
    exports: [NotifierCoreModule, NotificationChannelsService],
})
export class NotifierModule {}
