import { Module } from '@nestjs/common';
import { EffectivePlanService } from './effective-plan.service';

@Module({
    providers: [EffectivePlanService],
    exports: [EffectivePlanService],
})
export class SharedSubscriptionModule {}
