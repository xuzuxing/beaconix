import { Module } from '@nestjs/common';
import { AdminAlertDeliveriesController } from './alert-deliveries/admin-alert-deliveries.controller';
import { AdminAlertDeliveriesService } from './alert-deliveries/admin-alert-deliveries.service';
import { QueuesModule } from '../../infra/queue/queues.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { BillingModule } from '../billing/billing.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProbeValidationModule } from '../probes/probe-validation.module';
import { AdminAuditLogsController } from './audit-logs/admin-audit-logs.controller';
import { AdminAuditLogsService } from './audit-logs/admin-audit-logs.service';
import { AdminMetricsController } from './metrics/admin-metrics.controller';
import { AdminMetricsService } from './metrics/admin-metrics.service';
import { AdminOrdersController } from './orders/admin-orders.controller';
import { AdminOrdersService } from './orders/admin-orders.service';
import { AdminPlansController } from './plans/admin-plans.controller';
import { AdminPlansService } from './plans/admin-plans.service';
import { AdminRefundsController } from './refunds/admin-refunds.controller';
import { AdminRefundsService } from './refunds/admin-refunds.service';
import { SystemProbesController } from './system-probes/system-probes.controller';
import { SystemProbeAssignmentStore } from './system-probes/system-probe-assignment.store';
import { SystemProbeScheduler } from './system-probes/system-probe-scheduler';
import { SystemProbesService } from './system-probes/system-probes.service';
import { AdminTenantsController } from './tenants/admin-tenants.controller';
import { AdminTenantsService } from './tenants/admin-tenants.service';
import { AdminTicketCategoriesController } from './tickets/admin-ticket-categories.controller';
import { AdminTicketCategoriesService } from './tickets/admin-ticket-categories.service';
import { AdminTicketsController } from './tickets/admin-tickets.controller';
import { AdminTicketsService } from './tickets/admin-tickets.service';

@Module({
    imports: [
        ProbeValidationModule,
        QueuesModule,
        AttachmentsModule,
        BillingModule,
        NotificationsModule,
    ],
    controllers: [
        AdminAlertDeliveriesController,
        SystemProbesController,
        AdminTenantsController,
        AdminMetricsController,
        AdminAuditLogsController,
        AdminOrdersController,
        AdminRefundsController,
        AdminPlansController,
        AdminTicketsController,
        AdminTicketCategoriesController,
    ],
    providers: [
        AdminAlertDeliveriesService,
        SystemProbesService,
        SystemProbeScheduler,
        SystemProbeAssignmentStore,
        AdminTenantsService,
        AdminMetricsService,
        AdminAuditLogsService,
        AdminOrdersService,
        AdminRefundsService,
        AdminPlansService,
        AdminTicketsService,
        AdminTicketCategoriesService,
    ],
    exports: [SystemProbeScheduler],
})
export class AdminModule {}
