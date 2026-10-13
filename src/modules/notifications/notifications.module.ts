import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationStreamService } from './notification-stream.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { NotificationAccessService } from './notification-access.service';

@Global()
@Module({
    imports: [AuthorizationModule],
    controllers: [NotificationsController],
    providers: [
        NotificationsService,
        NotificationStreamService,
        NotificationDeliveryService,
        NotificationAccessService,
    ],
    exports: [NotificationsService],
})
export class NotificationsModule {}
