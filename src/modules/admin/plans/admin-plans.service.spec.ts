import {
    BadRequestException,
    ConflictException,
    NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../infra/database/prisma.service';
import { AdminPlansService } from './admin-plans.service';
import type { CreatePlanDto, UpdatePlanDto } from './dto';

const monthlyTerm = {
    id: 'term-pro-monthly',
    planId: 'plan-pro',
    cycle: 'MONTHLY',
    durationDays: 30,
    price: 2900,
    enabled: true,
    sortOrder: 1,
};

const yearlyTerm = {
    id: 'term-pro-yearly',
    planId: 'plan-pro',
    cycle: 'YEARLY',
    durationDays: 365,
    price: 29000,
    enabled: true,
    sortOrder: 3,
};

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
    terms: [monthlyTerm, yearlyTerm],
};

const freePlanRow = { ...planRow, id: 'plan-free', code: 'FREE', price: 0 };

function prismaError(code: string) {
    return new Prisma.PrismaClientKnownRequestError('constraint failed', {
        code,
        clientVersion: 'test',
    });
}

function createService() {
    const tx = {
        planTerm: {
            findMany: jest.fn(),
            update: jest.fn(),
            create: jest.fn(),
            delete: jest.fn(),
        },
        order: { count: jest.fn() },
        plan: { update: jest.fn() },
    };

    const prisma = {
        plan: {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            create: jest.fn(),
            delete: jest.fn(),
        },
        order: { count: jest.fn() },
        subscription: { count: jest.fn() },
        $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
    };

    const service = new AdminPlansService(prisma as unknown as PrismaService);

    return { service, prisma, tx };
}

describe('AdminPlansService', () => {
    it('lists every plan (disabled included) with all of its cycles', async () => {
        const { service, prisma } = createService();
        prisma.plan.findMany.mockResolvedValue([
            planRow,
            { ...freePlanRow, enabled: false },
        ]);

        const plans = await service.findAll();

        expect(prisma.plan.findMany).toHaveBeenCalledWith({
            orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
            include: {
                terms: { orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }] },
            },
        });
        expect(plans.map((plan) => plan.code)).toEqual(['PRO', 'FREE']);
        expect(plans[0].terms).toHaveLength(2);
    });

    it('returns 404 for a plan that does not exist', async () => {
        const { service, prisma } = createService();
        prisma.plan.findUnique.mockResolvedValue(null);

        await expect(service.findOne('missing')).rejects.toThrow(
            NotFoundException,
        );
    });

    it('creates a plan whose price mirrors the cheapest enabled cycle', async () => {
        const { service, prisma } = createService();
        prisma.plan.create.mockImplementation(({ data }) =>
            Promise.resolve({
                ...planRow,
                ...data,
                // The nested write is `{ create: [...] }`; the row comes back
                // as a plain array of terms.
                terms: data.terms?.create ?? [],
            }),
        );

        const dto: CreatePlanDto = {
            code: '  pro  ',
            name: '专业版',
            allowedMonitorTypes: ['HTTP', 'HTTP', 'TCP'],
            terms: [
                { cycle: 'MONTHLY', durationDays: 30, price: 2900 },
                { cycle: 'YEARLY', durationDays: 365, price: 29000 },
            ],
        };

        const plan = await service.create(dto);

        expect(prisma.plan.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                code: 'PRO',
                price: 2900,
                durationDays: 30,
                allowedMonitorTypes: ['HTTP', 'TCP'],
                terms: {
                    create: [
                        expect.objectContaining({
                            cycle: 'MONTHLY',
                            price: 2900,
                        }),
                        expect.objectContaining({
                            cycle: 'YEARLY',
                            price: 29000,
                        }),
                    ],
                },
            }),
            include: {
                terms: { orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }] },
            },
        });
        expect(plan.code).toBe('PRO');
    });

    it('refuses a plan without any enabled cycle', async () => {
        const { service, prisma } = createService();

        await expect(
            service.create({
                code: 'PRO',
                name: '专业版',
                terms: [
                    {
                        cycle: 'MONTHLY',
                        durationDays: 30,
                        price: 2900,
                        enabled: false,
                    },
                ],
            }),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.plan.create).not.toHaveBeenCalled();
    });

    it('maps a duplicate code to 409', async () => {
        const { service, prisma } = createService();
        prisma.plan.create.mockRejectedValue(prismaError('P2002'));

        await expect(
            service.create({
                code: 'PRO',
                name: '专业版',
                terms: [{ cycle: 'MONTHLY', durationDays: 30, price: 2900 }],
            }),
        ).rejects.toThrow(ConflictException);
    });

    it('rejects changing the code', async () => {
        const { service, prisma } = createService();
        prisma.plan.findUnique.mockResolvedValue(planRow);

        const dto: UpdatePlanDto = { code: 'ENTERPRISE' };

        await expect(service.update('plan-pro', dto)).rejects.toThrow(
            BadRequestException,
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('updates only the fields that were sent and keeps the default mirror', async () => {
        const { service, prisma, tx } = createService();
        prisma.plan.findUnique.mockResolvedValue(planRow);
        tx.planTerm.findMany.mockResolvedValue([monthlyTerm, yearlyTerm]);
        tx.plan.update.mockResolvedValue({ ...planRow, enabled: false });

        const plan = await service.update('plan-pro', {
            code: 'pro',
            enabled: false,
        });

        expect(tx.planTerm.update).not.toHaveBeenCalled();
        expect(tx.plan.update).toHaveBeenCalledWith({
            where: { id: 'plan-pro' },
            data: {
                enabled: false,
                price: 2900,
                durationDays: 30,
            },
            include: {
                terms: { orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }] },
            },
        });
        expect(plan.enabled).toBe(false);
    });

    it('clears the description when null is sent', async () => {
        const { service, prisma, tx } = createService();
        prisma.plan.findUnique.mockResolvedValue(planRow);
        tx.planTerm.findMany.mockResolvedValue([monthlyTerm, yearlyTerm]);
        tx.plan.update.mockResolvedValue({ ...planRow, description: null });

        await service.update('plan-pro', { description: null });

        expect(tx.plan.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ description: null }),
            }),
        );
    });

    it('upserts sent cycles and deletes unreferenced ones that disappear', async () => {
        const { service, prisma, tx } = createService();
        prisma.plan.findUnique.mockResolvedValue(planRow);
        tx.planTerm.findMany
            .mockResolvedValueOnce([monthlyTerm, yearlyTerm])
            .mockResolvedValueOnce([monthlyTerm]);
        tx.order.count.mockResolvedValue(0);
        tx.plan.update.mockResolvedValue(planRow);

        await service.update('plan-pro', {
            terms: [
                { cycle: 'MONTHLY', durationDays: 30, price: 2700 },
                { cycle: 'QUARTERLY', durationDays: 90, price: 7900 },
            ],
        });

        expect(tx.planTerm.update).toHaveBeenCalledWith({
            where: { id: 'term-pro-monthly' },
            data: {
                durationDays: 30,
                price: 2700,
                enabled: true,
                sortOrder: 0,
                wechatProductId: null,
            },
        });
        expect(tx.planTerm.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                planId: 'plan-pro',
                cycle: 'QUARTERLY',
                price: 7900,
            }),
        });
        expect(tx.planTerm.delete).toHaveBeenCalledWith({
            where: { id: 'term-pro-yearly' },
        });
    });

    it('disables a dropped cycle that orders still reference', async () => {
        const { service, prisma, tx } = createService();
        prisma.plan.findUnique.mockResolvedValue(planRow);
        tx.planTerm.findMany
            .mockResolvedValueOnce([monthlyTerm, yearlyTerm])
            .mockResolvedValueOnce([monthlyTerm]);
        tx.order.count.mockResolvedValue(3);
        tx.plan.update.mockResolvedValue(planRow);

        await service.update('plan-pro', {
            terms: [{ cycle: 'MONTHLY', durationDays: 30, price: 2900 }],
        });

        expect(tx.planTerm.delete).not.toHaveBeenCalled();
        expect(tx.planTerm.update).toHaveBeenCalledWith({
            where: { id: 'term-pro-yearly' },
            data: { enabled: false },
        });
    });

    it('refuses to leave the plan without an enabled cycle', async () => {
        const { service, prisma, tx } = createService();
        prisma.plan.findUnique.mockResolvedValue(planRow);
        tx.planTerm.findMany.mockResolvedValue([
            { ...monthlyTerm, enabled: false },
            { ...yearlyTerm, enabled: false },
        ]);

        await expect(
            service.update('plan-pro', {
                terms: [
                    {
                        cycle: 'MONTHLY',
                        durationDays: 30,
                        price: 2900,
                        enabled: false,
                    },
                    {
                        cycle: 'YEARLY',
                        durationDays: 365,
                        price: 29000,
                        enabled: false,
                    },
                ],
            }),
        ).rejects.toThrow(BadRequestException);
        expect(tx.plan.update).not.toHaveBeenCalled();
    });

    it('maps a vanished row on update to 404', async () => {
        const { service, prisma, tx } = createService();
        prisma.plan.findUnique.mockResolvedValue(planRow);
        tx.planTerm.findMany.mockResolvedValue([monthlyTerm]);
        tx.plan.update.mockRejectedValue(prismaError('P2025'));

        await expect(
            service.update('plan-pro', { name: '新名字' }),
        ).rejects.toThrow(NotFoundException);
    });

    it('refuses to delete a plan referenced by orders or subscriptions', async () => {
        const { service, prisma } = createService();
        prisma.plan.findUnique.mockResolvedValue(planRow);
        prisma.order.count.mockResolvedValue(12);
        prisma.subscription.count.mockResolvedValue(3);

        await expect(service.remove('plan-pro')).rejects.toThrow(
            ConflictException,
        );
        expect(prisma.plan.delete).not.toHaveBeenCalled();
    });

    it('never deletes the FREE fallback plan', async () => {
        const { service, prisma } = createService();
        prisma.plan.findUnique.mockResolvedValue(freePlanRow);

        await expect(service.remove('plan-free')).rejects.toThrow(
            ConflictException,
        );
        expect(prisma.plan.delete).not.toHaveBeenCalled();
    });

    it('deletes an unreferenced plan', async () => {
        const { service, prisma } = createService();
        prisma.plan.findUnique.mockResolvedValue(planRow);
        prisma.order.count.mockResolvedValue(0);
        prisma.subscription.count.mockResolvedValue(0);
        prisma.plan.delete.mockResolvedValue(planRow);

        await service.remove('plan-pro');

        expect(prisma.plan.delete).toHaveBeenCalledWith({
            where: { id: 'plan-pro' },
        });
    });

    it('maps a foreign-key block on delete to 409', async () => {
        const { service, prisma } = createService();
        prisma.plan.findUnique.mockResolvedValue(planRow);
        prisma.order.count.mockResolvedValue(0);
        prisma.subscription.count.mockResolvedValue(0);
        prisma.plan.delete.mockRejectedValue(prismaError('P2003'));

        await expect(service.remove('plan-pro')).rejects.toThrow(
            ConflictException,
        );
    });
});
