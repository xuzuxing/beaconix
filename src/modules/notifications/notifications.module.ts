import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationStreamService } from './notification-stream.service';
import { NotificationDeliveryService } from './notification-delivery.service';

@Global()
@Module({
    controllers: [NotificationsController],
    providers: [
        NotificationsService,
        NotificationStreamService,
        NotificationDeliveryService,
    ],
    exports: [NotificationsService],
})
export class NotificationsModule {}
