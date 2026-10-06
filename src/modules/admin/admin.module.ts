import { Module } from '@nestjs/common';
import { QueuesModule } from '../../infra/queue/queues.module';
import { ProbeValidationModule } from '../probes/probe-validation.module';
import { AdminAuditLogsController } from './audit-logs/admin-audit-logs.controller';
import { AdminAuditLogsService } from './audit-logs/admin-audit-logs.service';
import { AdminMetricsController } from './metrics/admin-metrics.controller';
import { AdminMetricsService } from './metrics/admin-metrics.service';
import { SystemProbesController } from './system-probes/system-probes.controller';
import { SystemProbeAssignmentStore } from './system-probes/system-probe-assignment.store';
import { SystemProbeScheduler } from './system-probes/system-probe-scheduler';
import { SystemProbesService } from './system-probes/system-probes.service';
import { AdminTenantsController } from './tenants/admin-tenants.controller';
import { AdminTenantsService } from './tenants/admin-tenants.service';

@Module({
    imports: [ProbeValidationModule, QueuesModule],
    controllers: [
        SystemProbesController,
        AdminTenantsController,
        AdminMetricsController,
        AdminAuditLogsController,
    ],
    providers: [
        SystemProbesService,
        SystemProbeScheduler,
        SystemProbeAssignmentStore,
        AdminTenantsService,
        AdminMetricsService,
        AdminAuditLogsService,
    ],
    exports: [SystemProbeScheduler],
})
export class AdminModule {}
