import { SubscriptionService } from './subscription.service';
import type { EffectivePlanService } from '../../../shared/subscription/effective-plan.service';

function createService() {
    const effectivePlanService = {
        getSubscriptionStack: jest.fn(),
    };

    const service = new SubscriptionService(
        effectivePlanService as unknown as EffectivePlanService,
    );

    return { service, effectivePlanService };
}

describe('SubscriptionService', () => {
    it('maps the subscription stack to entities', async () => {
        const { service, effectivePlanService } = createService();
        effectivePlanService.getSubscriptionStack.mockResolvedValue({
            effectivePlan: {
                id: 'plan-pro',
                code: 'PRO',
                name: '专业版',
                sortOrder: 2,
            },
            stack: [
                {
                    id: 'sub-1',
                    plan: {
                        id: 'plan-pro',
                        code: 'PRO',
                        name: '专业版',
                        sortOrder: 2,
                    },
                    expiresAt: new Date('2026-11-01T00:00:00.000Z'),
                    isEffective: true,
                },
            ],
        });

        const result = await service.getStack('org-1');

        expect(result.effectivePlan?.code).toBe('PRO');
        expect(result.stack[0].isEffective).toBe(true);
    });
});
