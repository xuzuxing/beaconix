import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { InvitationsModule } from '../invitations/invitations.module';
import {
    TokenCleanupService,
    InvitationExpiryService,
    TaskDueSoonService,
    TaskOverdueService,
    MonitorDataCleanupService,
    AttachmentCleanupService,
} from './jobs';

@Module({
    imports: [NotificationsModule, InvitationsModule, AttachmentsModule],
    providers: [
        TokenCleanupService,
        InvitationExpiryService,
        TaskDueSoonService,
        TaskOverdueService,
        MonitorDataCleanupService,
        AttachmentCleanupService,
    ],
})
export class CronModule {}
