import { Test, TestingModule } from '@nestjs/testing';
import { OrgMemberGuard, RolesGuard } from '../../common/guards';
import { OrderController } from './order/order.controller';
import { OrderService } from './order/order.service';
import { PaymentController } from './payment/payment.controller';
import { PaymentService } from './payment/payment.service';
import { PlanController } from './plan/plan.controller';
import { PlanService } from './plan/plan.service';
import { QuotaController } from './quota/quota.controller';
import { SubscriptionController } from './subscription/subscription.controller';
import { SubscriptionService } from './subscription/subscription.service';
import { QuotaService } from '../../shared/quota/quota.service';

describe('Billing controllers', () => {
    async function createModule() {
        const module: TestingModule = await Test.createTestingModule({
            controllers: [
                PlanController,
                SubscriptionController,
                OrderController,
                PaymentController,
                QuotaController,
            ],
            providers: [
                {
                    provide: PlanService,
                    useValue: { findAll: jest.fn(), findOne: jest.fn() },
                },
                {
                    provide: SubscriptionService,
                    useValue: { getStack: jest.fn() },
                },
                {
                    provide: OrderService,
                    useValue: {
                        create: jest.fn(),
                        findAll: jest.fn(),
                        findOne: jest.fn(),
                        cancel: jest.fn(),
                    },
                },
                {
                    provide: PaymentService,
                    useValue: {
                        createPayment: jest.fn(),
                        handleWechatCallback: jest.fn(),
                    },
                },
                {
                    provide: QuotaService,
                    useValue: { getUsageSummary: jest.fn() },
                },
            ],
        })
            .overrideGuard(OrgMemberGuard)
            .useValue({ canActivate: () => true })
            .overrideGuard(RolesGuard)
            .useValue({ canActivate: () => true })
            .compile();

        return module;
    }

    it('instantiates the billing controllers', async () => {
        const module = await createModule();

        expect(module.get(PlanController)).toBeDefined();
        expect(module.get(SubscriptionController)).toBeDefined();
        expect(module.get(OrderController)).toBeDefined();
        expect(module.get(PaymentController)).toBeDefined();
        expect(module.get(QuotaController)).toBeDefined();
    });
});
