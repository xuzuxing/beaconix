import type { ScheduledJobRegistry } from '../../../infra/scheduler/scheduled-job.registry';
import { SCHEDULED_JOBS } from '../../../infra/scheduler/scheduled-jobs.constants';
import type { WechatVirtualPaymentService } from '../../billing/payment/wechat-virtual-payment.service';
import { WechatVirtualPayReconcileService } from './wechat-virtual-pay-reconcile.service';

function createService() {
    const registry = { register: jest.fn() };
    const virtualPay = {
        reconcilePendingAttempts: jest
            .fn()
            .mockResolvedValue({ checked: 0, settled: 0 }),
    };

    const service = new WechatVirtualPayReconcileService(
        registry as unknown as ScheduledJobRegistry,
        virtualPay as unknown as WechatVirtualPaymentService,
    );

    return { service, registry, virtualPay };
}

describe('WechatVirtualPayReconcileService', () => {
    it('registers the reconcile job with the 5-minute pattern', () => {
        const { service, registry } = createService();

        service.onModuleInit();

        expect(registry.register).toHaveBeenCalledWith(
            expect.objectContaining({
                name: SCHEDULED_JOBS.wechatVirtualPayReconcile,
                pattern: '*/5 * * * *',
            }),
        );
    });

    it('delegates the sweep to the virtual payment service', async () => {
        const { service, virtualPay } = createService();
        virtualPay.reconcilePendingAttempts.mockResolvedValue({
            checked: 3,
            settled: 1,
        });

        await expect(service.handleReconcile()).resolves.toEqual({
            checked: 3,
            settled: 1,
        });
        expect(virtualPay.reconcilePendingAttempts).toHaveBeenCalledTimes(1);
    });
});
