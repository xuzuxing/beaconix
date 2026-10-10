import { Module } from '@nestjs/common';
import { AlertEventsService } from './alert-events.service';
import { AlertEventsController } from './alert-events.controller';

@Module({
    controllers: [AlertEventsController],
    providers: [AlertEventsService],
    exports: [AlertEventsService],
})
export class AlertEventsModule {}
