import { Injectable } from '@nestjs/common';
import { EffectivePlanService } from '../../../shared/subscription/effective-plan.service';
import { PlanEntity } from '../plan/entities';
import {
    SubscriptionStackEntity,
    SubscriptionStackEntryEntity,
} from './entities';

@Injectable()
export class SubscriptionService {
    constructor(private readonly effectivePlanService: EffectivePlanService) {}

    async getStack(organizationId: string): Promise<SubscriptionStackEntity> {
        const stack =
            await this.effectivePlanService.getSubscriptionStack(
                organizationId,
            );

        return new SubscriptionStackEntity({
            effectivePlan: stack.effectivePlan
                ? new PlanEntity(stack.effectivePlan)
                : null,
            stack: stack.stack.map(
                (entry) =>
                    new SubscriptionStackEntryEntity({
                        id: entry.id,
                        plan: new PlanEntity(entry.plan),
                        startsAt: entry.startsAt,
                        expiresAt: entry.expiresAt,
                        status: entry.status,
                        pausedRemainingDays: entry.pausedRemainingDays,
                        isEffective: entry.isEffective,
                    }),
            ),
        });
    }
}
