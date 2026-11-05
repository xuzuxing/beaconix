import { ProjectRumController } from './project/project-rum.controller';
import { ProjectRumService } from './project/project-rum.service';
import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { NotifierCoreModule } from '../notifier/notifier-core.module';
import { RumAlertEvaluatorService } from './alerts/rum-alert-evaluator.service';
import { RumAlertRulesController } from './alerts/rum-alert-rules.controller';
import { RumAlertRulesService } from './alerts/rum-alert-rules.service';
import { RumAppsController } from './apps/rum-apps.controller';
import { RumAppsService } from './apps/rum-apps.service';
import { RumAppOverviewController } from './overview/rum-app-overview.controller';
import { RumAppOverviewService } from './overview/rum-app-overview.service';
import { RumEventsController } from './events/rum-events.controller';
import { RumEventsService } from './events/rum-events.service';
import { RumErrorsController } from './errors/rum-errors.controller';
import { RumErrorsService } from './errors/rum-errors.service';
import { RumErrorOverviewService } from './errors/rum-error-overview.service';
import { RumIngestController } from './ingest/rum-ingest.controller';
import { RumMaintenanceController } from './maintenance/rum-maintenance.controller';
import { RumPerformanceController } from './performance/rum-performance.controller';
import { RumPerformanceService } from './performance/rum-performance.service';
import { RumMaintenanceService } from './maintenance/rum-maintenance.service';
import { RumIngestService } from './ingest/rum-ingest.service';
import { RumPerformanceIngestService } from './ingest/rum-performance-ingest.service';
import { RumPublicIngestService } from './ingest/rum-public-ingest.service';
import { RumRateLimitService } from './ingest/rum-rate-limit.service';
import { RumReleasesController } from './releases/rum-releases.controller';
import { RumReleasesService } from './releases/rum-releases.service';
import { RumReplaysController } from './replays/rum-replays.controller';
import { RumReplaysService } from './replays/rum-replays.service';
import { RumRetentionService } from './retention/rum-retention.service';
import { RumSourceMapsController } from './source-maps/rum-source-maps.controller';
import { RumSourceMapsService } from './source-maps/rum-source-maps.service';

@Module({
    imports: [AuthorizationModule, NotifierCoreModule],
    controllers: [
        ProjectRumController,
        RumAppsController,
        RumAppOverviewController,
        RumErrorsController,
        RumEventsController,
        RumReplaysController,
        RumReleasesController,
        RumSourceMapsController,
        RumAlertRulesController,
        RumIngestController,
        RumMaintenanceController,
        RumPerformanceController,
    ],
    providers: [
        ProjectRumService,
        RumAppsService,
        RumAppOverviewService,
        RumErrorsService,
        RumErrorOverviewService,
        RumEventsService,
        RumReplaysService,
        RumReleasesService,
        RumSourceMapsService,
        RumAlertRulesService,
        RumAlertEvaluatorService,
        RumIngestService,
        RumPublicIngestService,
        RumRateLimitService,
        RumRetentionService,
        RumMaintenanceService,
        RumPerformanceService,
        RumPerformanceIngestService,
    ],
    exports: [RumAppsService, RumErrorsService, RumEventsService],
})
export class RumModule {}
