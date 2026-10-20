import { NotFoundException } from '@nestjs/common';
import { PlanService } from './plan.service';
import type { PrismaService } from '../../../infra/database/prisma.service';

const planRow = {
    id: 'plan-pro',
    code: 'PRO',
    name: '专业版',
    description: null,
    price: 2900,
    durationDays: 30,
    sortOrder: 2,
    maxMonitors: 50,
    maxProbes: 3,
    maxProbesPerMonitor: 1,
    maxApiKeys: 5,
    maxMembers: 10,
    maxChannels: 5,
    minInterval: 60,
    allowTenantProbe: true,
    allowStatusPage: true,
    allowedMonitorTypes: ['HTTP', 'TCP'],
    enabled: true,
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
    terms: [
        {
            id: 'term-pro-monthly',
            planId: 'plan-pro',
            cycle: 'MONTHLY',
            durationDays: 30,
            price: 2900,
            enabled: true,
            sortOrder: 1,
        },
    ],
};

function createService() {
    const prisma = {
        plan: { findMany: jest.fn(), findUnique: jest.fn() },
    };

    const service = new PlanService(prisma as unknown as PrismaService);

    return { service, prisma };
}

describe('PlanService', () => {
    it('lists enabled plans with their purchasable cycles ordered by priority', async () => {
        const { service, prisma } = createService();
        prisma.plan.findMany.mockResolvedValue([planRow]);

        const plans = await service.findAll();

        expect(prisma.plan.findMany).toHaveBeenCalledWith({
            where: { enabled: true },
            orderBy: { sortOrder: 'asc' },
            include: {
                terms: {
                    where: { enabled: true },
                    orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }],
                },
            },
        });
        expect(plans[0].code).toBe('PRO');
        expect(plans[0].terms).toEqual([
            expect.objectContaining({
                cycle: 'MONTHLY',
                durationDays: 30,
                price: 2900,
            }),
        ]);
    });

    it('hides disabled plans and returns 404 for missing plans', async () => {
        const { service, prisma } = createService();
        prisma.plan.findUnique.mockResolvedValue({
            ...planRow,
            enabled: false,
        });

        await expect(service.findOne('plan-pro')).rejects.toThrow(
            NotFoundException,
        );
    });
});
