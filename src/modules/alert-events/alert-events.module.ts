import { Module } from '@nestjs/common';
import { AlertEventsService } from './alert-events.service';
import { AlertEventsController } from './alert-events.controller';
import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { MonitorNoDataService } from './monitor-no-data.service';
import { AlertEventQueriesController } from './alert-event-queries.controller';
import { AlertEventQueriesService } from './alert-event-queries.service';

@Module({
    imports: [AuthorizationModule],
    controllers: [AlertEventsController, AlertEventQueriesController],
    providers: [
        AlertEventsService,
        MonitorNoDataService,
        AlertEventQueriesService,
    ],
    exports: [AlertEventsService],
})
export class AlertEventsModule {}
