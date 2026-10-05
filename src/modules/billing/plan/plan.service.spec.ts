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
    maxMembers: 10,
    maxChannels: 5,
    minInterval: 60,
    allowTenantProbe: true,
    allowStatusPage: true,
    enabled: true,
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
};

function createService() {
    const prisma = {
        plan: { findMany: jest.fn(), findUnique: jest.fn() },
    };

    const service = new PlanService(prisma as unknown as PrismaService);

    return { service, prisma };
}

describe('PlanService', () => {
    it('lists enabled plans ordered by priority', async () => {
        const { service, prisma } = createService();
        prisma.plan.findMany.mockResolvedValue([planRow]);

        const plans = await service.findAll();

        expect(prisma.plan.findMany).toHaveBeenCalledWith({
            where: { enabled: true },
            orderBy: { sortOrder: 'asc' },
        });
        expect(plans[0].code).toBe('PRO');
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
