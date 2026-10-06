import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import {
    TokenCleanupService,
    InvitationExpiryService,
    TaskDueSoonService,
    TaskOverdueService,
    MonitorDataCleanupService,
} from './jobs';

@Module({
    imports: [NotificationsModule],
    providers: [
        TokenCleanupService,
        InvitationExpiryService,
        TaskDueSoonService,
        TaskOverdueService,
        MonitorDataCleanupService,
    ],
})
export class CronModule {}
