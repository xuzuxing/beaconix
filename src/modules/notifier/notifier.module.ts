import { Module } from '@nestjs/common';
import { QueuesModule } from '../../infra/queue/queues.module';
import { WechatModule } from '../../infra/wechat/wechat.module';
import { StateModule } from '../state/state.module';
import { NotificationChannelsController } from './notification-channels.controller';
import { NotificationChannelsService } from './notification-channels.service';
import { NotificationsProcessor } from './notifications.processor';
import { NotifierService } from './notifier.service';
import { AlertOutboxService } from './alert-outbox.service';
import {
    DingtalkSender,
    EmailSender,
    FeishuSender,
    WechatSubscribeSender,
    WecomSender,
} from './senders';

@Module({
    imports: [StateModule, WechatModule, QueuesModule],
    controllers: [NotificationChannelsController],
    providers: [
        NotificationChannelsService,
        NotifierService,
        AlertOutboxService,
        NotificationsProcessor,
        FeishuSender,
        WecomSender,
        DingtalkSender,
        WechatSubscribeSender,
        EmailSender,
    ],
    exports: [NotifierService, NotificationChannelsService],
})
export class NotifierModule {}
