import { ForbiddenException } from '@nestjs/common';
import { QuotaService } from './quota.service';
import type { PrismaService } from '../../infra/database/prisma.service';
import type { EffectivePlanService } from '../subscription/effective-plan.service';

const freePlan = {
    id: 'plan-free',
    code: 'FREE',
    name: '免费版',
    price: 0,
    maxMonitors: 5,
    maxProbes: 0,
    maxMembers: 3,
    maxChannels: 1,
    minInterval: 300,
    allowTenantProbe: false,
    allowStatusPage: false,
};

function createService() {
    const prisma = {
        monitor: { count: jest.fn() },
        probe: { count: jest.fn() },
        membership: { count: jest.fn() },
        notificationChannel: { count: jest.fn() },
    };
    const effectivePlanService = {
        getEffectivePlan: jest.fn().mockResolvedValue(freePlan),
    };

    const service = new QuotaService(
        prisma as unknown as PrismaService,
        effectivePlanService as unknown as EffectivePlanService,
    );

    return { service, prisma, effectivePlanService };
}

describe('QuotaService', () => {
    it('aggregates usage across the four quota resources', async () => {
        const { service, prisma } = createService();
        prisma.monitor.count.mockResolvedValue(3);
        prisma.probe.count.mockResolvedValue(0);
        prisma.membership.count.mockResolvedValue(2);
        prisma.notificationChannel.count.mockResolvedValue(1);

        await expect(service.getUsage('org-1')).resolves.toEqual({
            monitors: 3,
            probes: 0,
            members: 2,
            channels: 1,
        });
    });

    it('throws QUOTA_EXCEEDED when the resource limit is reached', async () => {
        const { service, prisma } = createService();
        prisma.monitor.count.mockResolvedValue(5);

        const promise = service.assertCanCreate('org-1', 'monitors');

        await expect(promise).rejects.toThrow(ForbiddenException);
        await expect(promise).rejects.toMatchObject({
            response: {
                code: 'QUOTA_EXCEEDED',
                resource: 'monitors',
                current: 5,
                limit: 5,
            },
        });
    });

    it('allows creation when usage is below the limit', async () => {
        const { service, prisma } = createService();
        prisma.monitor.count.mockResolvedValue(4);

        await expect(
            service.assertCanCreate('org-1', 'monitors'),
        ).resolves.toBeUndefined();
    });

    it('blocks features that are not included in the plan', async () => {
        const { service } = createService();

        await expect(
            service.assertFeatureAllowed('org-1', 'tenantProbe'),
        ).rejects.toThrow(ForbiddenException);
    });

    it('blocks intervals shorter than the plan minimum', async () => {
        const { service } = createService();

        await expect(
            service.assertIntervalAllowed('org-1', 60),
        ).rejects.toThrow(ForbiddenException);
    });

    it('builds the usage summary with percent values', async () => {
        const { service, prisma } = createService();
        prisma.monitor.count.mockResolvedValue(3);
        prisma.probe.count.mockResolvedValue(0);
        prisma.membership.count.mockResolvedValue(2);
        prisma.notificationChannel.count.mockResolvedValue(1);

        const summary = await service.getUsageSummary('org-1');

        expect(summary.plan.code).toBe('FREE');
        expect(summary.resources.monitors).toEqual({
            used: 3,
            limit: 5,
            percent: 60,
        });
        expect(summary.features.allowTenantProbe).toBe(false);
    });
});
