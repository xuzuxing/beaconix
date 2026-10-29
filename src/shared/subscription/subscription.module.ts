import { Module } from '@nestjs/common';
import { EffectivePlanService } from './effective-plan.service';
import { MonitorCapacityService } from './monitor-capacity.service';

@Module({
    providers: [EffectivePlanService, MonitorCapacityService],
    exports: [EffectivePlanService, MonitorCapacityService],
})
export class SharedSubscriptionModule {}
