import { Module } from '@nestjs/common';
import { AlertEventsService } from './alert-events.service';
import { AlertEventsController } from './alert-events.controller';
import { AuthorizationModule } from '../../common/authorization/authorization.module';

@Module({
    imports: [AuthorizationModule],
    controllers: [AlertEventsController],
    providers: [AlertEventsService],
    exports: [AlertEventsService],
})
export class AlertEventsModule {}
