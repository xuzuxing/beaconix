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
    maxProbesPerMonitor: 0,
    maxMembers: 3,
    maxChannels: 1,
    maxApiKeys: 5,
    minInterval: 300,
    allowTenantProbe: false,
    allowStatusPage: false,
    allowedMonitorTypes: ['HTTP', 'TCP', 'PING'],
};

function createService() {
    const prisma = {
        monitor: { count: jest.fn() },
        probe: { count: jest.fn() },
        membership: { count: jest.fn() },
        notificationChannel: { count: jest.fn() },
        apiKey: { count: jest.fn() },
        $queryRaw: jest.fn(),
        $transaction: jest.fn(),
    };
    // The convenience wrapper opens its own transaction and takes the tenant
    // lock inside it; reusing `prisma` as `tx` keeps the count mocks shared.
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    const effectivePlanService = {
        getEffectivePlan: jest.fn().mockResolvedValue(freePlan),
        getEffectivePlanInTransaction: jest.fn().mockResolvedValue(freePlan),
    };

    const service = new QuotaService(
        prisma as unknown as PrismaService,
        effectivePlanService as unknown as EffectivePlanService,
    );

    return { service, prisma, effectivePlanService };
}

describe('QuotaService', () => {
    it('checks member limits with the supplied transaction only', async () => {
        const { service, prisma, effectivePlanService } = createService();
        const tx = { membership: { count: jest.fn().mockResolvedValue(2) } };
        await service.assertCanAddMember('org-1', tx as never);
        expect(
            effectivePlanService.getEffectivePlanInTransaction,
        ).toHaveBeenCalledWith('org-1', tx);
        expect(tx.membership.count).toHaveBeenCalledWith({
            where: { organizationId: 'org-1' },
        });
        expect(prisma.membership.count).not.toHaveBeenCalled();
        expect(effectivePlanService.getEffectivePlan).not.toHaveBeenCalled();
    });
    it('blocks the last member slot and retains the FREE fallback in the same transaction', async () => {
        const { service, effectivePlanService } = createService();
        effectivePlanService.getEffectivePlanInTransaction.mockResolvedValue(
            null,
        );
        const tx = { membership: { count: jest.fn().mockResolvedValue(3) } };
        await expect(
            service.assertCanAddMember('org-1', tx as never),
        ).rejects.toMatchObject({
            response: {
                code: 'QUOTA_EXCEEDED',
                resource: 'members',
                current: 3,
                limit: 3,
            },
        });
    });
    it('aggregates usage across the quota resources', async () => {
        const { service, prisma } = createService();
        prisma.monitor.count.mockResolvedValue(3);
        prisma.probe.count.mockResolvedValue(0);
        prisma.membership.count.mockResolvedValue(2);
        prisma.notificationChannel.count.mockResolvedValue(1);
        prisma.apiKey.count.mockResolvedValue(4);

        await expect(service.getUsage('org-1')).resolves.toEqual({
            monitors: 3,
            probes: 0,
            members: 2,
            channels: 1,
            apiKeys: 4,
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
        prisma.apiKey.count.mockResolvedValue(4);

        const summary = await service.getUsageSummary('org-1');

        expect(summary.plan.code).toBe('FREE');
        expect(summary.resources.monitors).toEqual({
            used: 3,
            limit: 5,
            percent: 60,
        });
        expect(summary.resources.apiKeys).toEqual({
            used: 4,
            limit: 5,
            percent: 80,
        });
        expect(summary.features.allowTenantProbe).toBe(false);
        expect(summary.allowedMonitorTypes).toEqual(['HTTP', 'TCP', 'PING']);
    });

    it('denies DNS on FREE and permits it on explicitly entitled plans', async () => {
        const { service, effectivePlanService } = createService();
        await expect(
            service.assertMonitorTypeAllowed('org-1', 'DNS'),
        ).rejects.toMatchObject({
            response: { code: 'MONITOR_TYPE_NOT_ALLOWED', type: 'DNS' },
        });
        effectivePlanService.getEffectivePlan.mockResolvedValue({
            ...freePlan,
            allowedMonitorTypes: ['HTTP', 'TCP', 'PING', 'DNS'],
        });
        await expect(
            service.assertMonitorTypeAllowed('org-1', 'DNS'),
        ).resolves.toBeUndefined();
    });

    it('uses an explicit safe type fallback when no FREE plan exists', async () => {
        const { service, effectivePlanService } = createService();
        effectivePlanService.getEffectivePlan.mockResolvedValue(null);
        expect(await service.monitorEligibility('org-1', 'PING', 300)).toEqual({
            eligible: true,
            reason: null,
        });
        expect(await service.monitorEligibility('org-1', 'DNS', 300)).toEqual({
            eligible: false,
            reason: 'MONITOR_TYPE_NOT_ALLOWED',
        });
    });

    it('re-evaluates runtime policy after a downgrade without changing monitor intent', async () => {
        const { service, effectivePlanService } = createService();
        effectivePlanService.getEffectivePlan.mockResolvedValueOnce({
            ...freePlan,
            allowedMonitorTypes: ['HTTP', 'TCP', 'PING', 'DNS'],
        });
        expect(
            (await service.monitorEligibility('org-1', 'DNS', 300)).eligible,
        ).toBe(true);
        expect(
            (await service.monitorEligibility('org-1', 'DNS', 300)).eligible,
        ).toBe(false);
        expect(await service.monitorEligibility('org-1', 'HTTP', 60)).toEqual({
            eligible: false,
            reason: 'INTERVAL_TOO_SHORT',
        });
    });

    describe('tenant probe binding budget', () => {
        const proPlan = {
            ...freePlan,
            code: 'PRO',
            name: '专业版',
            maxProbes: 10,
            maxProbesPerMonitor: 3,
            allowTenantProbe: true,
        };

        it('rejects a probe set above the organization probe allowance', async () => {
            const { service, effectivePlanService } = createService();
            effectivePlanService.getEffectivePlan.mockResolvedValue(proPlan);

            await expect(
                service.assertProbesAssignable('org-1', 11),
            ).rejects.toMatchObject({
                response: {
                    code: 'QUOTA_EXCEEDED',
                    resource: 'probesPerMonitor',
                    current: 11,
                    limit: 10,
                },
            });
            await expect(
                service.assertProbesAssignable('org-1', 10),
            ).resolves.toBeUndefined();
        });

        it('ignores maxProbesPerMonitor, which sizes the system probe pool', async () => {
            const { service, effectivePlanService } = createService();
            effectivePlanService.getEffectivePlan.mockResolvedValue({
                ...proPlan,
                maxProbes: 2,
                maxProbesPerMonitor: 10,
            });

            expect(await service.getProbeAssignmentLimit('org-1')).toBe(2);
        });

        it('falls back to the organization allowance when the column is absent', async () => {
            const { service, effectivePlanService } = createService();
            effectivePlanService.getEffectivePlan.mockResolvedValue({
                ...freePlan,
                maxProbes: 10,
                maxProbesPerMonitor: undefined,
            });

            expect(await service.getProbeAssignmentLimit('org-1')).toBe(10);
            await expect(
                service.assertProbesAssignable('org-1', 11),
            ).rejects.toMatchObject({
                response: { code: 'QUOTA_EXCEEDED', limit: 10 },
            });
        });

        it('exposes the allowance as maxProbesPerMonitor in the usage summary', async () => {
            const { service, prisma, effectivePlanService } = createService();
            effectivePlanService.getEffectivePlan.mockResolvedValue(proPlan);
            prisma.monitor.count.mockResolvedValue(0);
            prisma.probe.count.mockResolvedValue(0);
            prisma.membership.count.mockResolvedValue(0);
            prisma.notificationChannel.count.mockResolvedValue(0);
            prisma.apiKey.count.mockResolvedValue(0);

            const summary = await service.getUsageSummary('org-1');

            expect(summary.maxProbesPerMonitor).toBe(10);
        });
    });
});
