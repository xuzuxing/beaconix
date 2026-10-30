import { Module } from '@nestjs/common';
import { AlertEventsService } from './alert-events.service';
import { AlertEventsController } from './alert-events.controller';
import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { MonitorNoDataService } from './monitor-no-data.service';

@Module({
    imports: [AuthorizationModule],
    controllers: [AlertEventsController],
    providers: [AlertEventsService, MonitorNoDataService],
    exports: [AlertEventsService],
})
export class AlertEventsModule {}
