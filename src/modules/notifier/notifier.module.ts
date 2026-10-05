import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { RedisConfig } from '../../config';
import { StateModule } from '../state/state.module';
import { NotificationChannelsController } from './notification-channels.controller';
import { NotificationChannelsService } from './notification-channels.service';
import { NotificationsProcessor } from './notifications.processor';
import { NotifierService } from './notifier.service';
import { NOTIFICATION_QUEUE } from './notifier.queue';
import {
    DingtalkSender,
    EmailSender,
    FeishuSender,
    WechatSubscribeSender,
    WecomSender,
} from './senders';

@Module({
    imports: [
        StateModule,
        BullModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (config: ConfigService) => {
                const redis = config.get<RedisConfig>('redis')!;
                return {
                    connection: {
                        url: redis.url,
                        keyPrefix: redis.keyPrefix,
                        maxRetriesPerRequest: 3,
                    },
                };
            },
        }),
        BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
    ],
    controllers: [NotificationChannelsController],
    providers: [
        NotificationChannelsService,
        NotifierService,
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
