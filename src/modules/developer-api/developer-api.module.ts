import { Module } from '@nestjs/common';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { MonitorsModule } from '../monitors/monitors.module';
import { ProbesModule } from '../probes/probes.module';
import { StatusPagesModule } from '../status-pages/status-pages.module';
import { ApiCredentialsController } from './credentials/api-credentials.controller';
import { ApiCredentialsService } from './credentials/api-credentials.service';
import { DeveloperAuthGuard } from './auth/developer-auth.guard';
import { DeveloperMonitorsController } from './v1/developer-monitors.controller';
import { DeveloperOverviewController } from './v1/developer-overview.controller';
import { DeveloperProbesController } from './v1/developer-probes.controller';
import { DeveloperStatusPagesController } from './v1/developer-status-pages.controller';
import { PersonalAccessTokensController } from './credentials/personal-access-tokens.controller';
import { AuthorizationModule } from '../../common/authorization/authorization.module';

@Module({
    imports: [
        AuthorizationModule,
        MonitorsModule,
        ProbesModule,
        StatusPagesModule,
        MonitoringModule,
    ],
    controllers: [
        ApiCredentialsController,
        PersonalAccessTokensController,
        DeveloperMonitorsController,
        DeveloperProbesController,
        DeveloperStatusPagesController,
        DeveloperOverviewController,
    ],
    providers: [ApiCredentialsService, DeveloperAuthGuard],
    exports: [ApiCredentialsService, DeveloperAuthGuard],
})
export class DeveloperApiModule {}
