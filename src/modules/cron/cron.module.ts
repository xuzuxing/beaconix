import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { BillingModule } from '../billing/billing.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { InvitationsModule } from '../invitations/invitations.module';
import {
    TokenCleanupService,
    InvitationExpiryService,
    TaskDueSoonService,
    TaskOverdueService,
    MonitorDataCleanupService,
    AttachmentCleanupService,
    WechatVirtualPayReconcileService,
    RefundReconcileService,
    PaymentReconcileService,
} from './jobs';

@Module({
    imports: [
        NotificationsModule,
        InvitationsModule,
        AttachmentsModule,
        BillingModule,
    ],
    providers: [
        TokenCleanupService,
        InvitationExpiryService,
        TaskDueSoonService,
        TaskOverdueService,
        MonitorDataCleanupService,
        AttachmentCleanupService,
        WechatVirtualPayReconcileService,
        RefundReconcileService,
        PaymentReconcileService,
    ],
})
export class CronModule {}
