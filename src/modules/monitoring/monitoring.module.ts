import { Module } from '@nestjs/common';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { MonitoringDashboardService } from './monitoring-dashboard.service';
import { MonitoringDashboardController } from './monitoring-dashboard.controller';
import { MonitoringEtagInterceptor } from './monitoring-etag.interceptor';
import { AdminModule } from '../admin/admin.module';
import { CacheModule } from '../../infra/cache/cache.module';

@Module({
    imports: [AdminModule, CacheModule],
    controllers: [MonitoringController, MonitoringDashboardController],
    providers: [
        MonitoringService,
        MonitoringDashboardService,
        MonitoringEtagInterceptor,
    ],
    exports: [MonitoringService],
})
export class MonitoringModule {}
