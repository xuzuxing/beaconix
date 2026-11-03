import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { RumAppsController } from './apps/rum-apps.controller';
import { RumAppsService } from './apps/rum-apps.service';
import { RumErrorsController } from './errors/rum-errors.controller';
import { RumErrorsService } from './errors/rum-errors.service';
import { RumIngestController } from './ingest/rum-ingest.controller';
import { RumIngestService } from './ingest/rum-ingest.service';
import { RumRateLimitService } from './ingest/rum-rate-limit.service';
import { RumRetentionService } from './retention/rum-retention.service';

@Module({
    imports: [AuthorizationModule],
    controllers: [RumAppsController, RumErrorsController, RumIngestController],
    providers: [
        RumAppsService,
        RumErrorsService,
        RumIngestService,
        RumRateLimitService,
        RumRetentionService,
    ],
    exports: [RumAppsService, RumErrorsService],
})
export class RumModule {}
