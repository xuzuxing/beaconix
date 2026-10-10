import { Module } from '@nestjs/common';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { MonitoringDashboardService } from './monitoring-dashboard.service';
import { MonitoringDashboardController } from './monitoring-dashboard.controller';
import { MonitoringEtagInterceptor } from './monitoring-etag.interceptor';
import { AdminModule } from '../admin/admin.module';
import { CacheModule } from '../../infra/cache/cache.module';
import { MonitorInsightsController } from './monitor-insights.controller';
import { MonitorInsightsService } from './monitor-insights.service';

@Module({
    imports: [AdminModule, CacheModule],
    controllers: [
        MonitoringController,
        MonitoringDashboardController,
        MonitorInsightsController,
    ],
    providers: [
        MonitoringService,
        MonitoringDashboardService,
        MonitoringEtagInterceptor,
        MonitorInsightsService,
    ],
    exports: [MonitoringService],
})
export class MonitoringModule {}
