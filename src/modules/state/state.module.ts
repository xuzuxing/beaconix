import { Module } from '@nestjs/common';
import { StateController } from './state.controller';
import { StateService } from './state.service';
import { AlertEventsModule } from '../alert-events/alert-events.module';

@Module({
    imports: [AlertEventsModule],
    controllers: [StateController],
    providers: [StateService],
    exports: [StateService],
})
export class StateModule {}
