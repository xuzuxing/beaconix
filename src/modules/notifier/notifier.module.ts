import { Module } from '@nestjs/common';
import { StateModule } from '../state/state.module';
import { NotificationChannelsController } from './notification-channels.controller';
import { NotificationChannelsService } from './notification-channels.service';
import { NotifierService } from './notifier.service';
import {
    DingtalkSender,
    EmailSender,
    FeishuSender,
    WechatSubscribeSender,
    WecomSender,
} from './senders';

@Module({
    imports: [StateModule],
    controllers: [NotificationChannelsController],
    providers: [
        NotificationChannelsService,
        NotifierService,
        FeishuSender,
        WecomSender,
        DingtalkSender,
        WechatSubscribeSender,
        EmailSender,
    ],
    exports: [NotifierService, NotificationChannelsService],
})
export class NotifierModule {}
