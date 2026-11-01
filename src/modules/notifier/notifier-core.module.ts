import { Module } from '@nestjs/common';
import { WechatCoreModule } from '../../infra/wechat/wechat-core.module';
import { EmailModule } from '../email/email.module';
import { NotificationQueueModule } from './notification-queue.module';
import { NotifierService } from './notifier.service';
import {
    DingtalkSender,
    EmailSender,
    FeishuSender,
    WechatSubscribeSender,
    WecomSender,
} from './senders';

/**
 * Reusable delivery operations. Importing this module starts neither the legacy
 * notification worker nor the outbox sweep and exposes no management routes.
 * Callers must supply global config/database infrastructure.
 */
@Module({
    imports: [WechatCoreModule, EmailModule, NotificationQueueModule],
    providers: [
        NotifierService,
        FeishuSender,
        WecomSender,
        DingtalkSender,
        WechatSubscribeSender,
        EmailSender,
    ],
    exports: [NotifierService],
})
export class NotifierCoreModule {}
