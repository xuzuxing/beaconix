import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../../infra/database/prisma.service';
import { SystemProbesService } from './system-probes.service';

const systemProbeRow = {
    id: 'system-probe-1',
    organizationId: null,
    scope: 'SYSTEM',
    name: 'Global Tokyo probe',
    provider: 'TENCENT',
    region: 'ap-northeast-1',
    callbackUrl: 'https://probe.example.com/beacon/callback',
    secret: 'secret-1',
    enabled: true,
    lastHeartbeat: null,
    status: 'OFFLINE',
    maxTenants: 100,
    priority: 10,
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
};

function createService() {
    const prisma = {
        probe: {
            create: jest.fn(),
            findMany: jest.fn(),
            findFirst: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        },
    };
    const systemProbeScheduler = { rebalance: jest.fn().mockResolvedValue({}) };

    const service = new SystemProbesService(
        prisma as unknown as PrismaService,
        systemProbeScheduler as never,
    );

    return { service, prisma, systemProbeScheduler };
}

describe('SystemProbesService', () => {
    it('creates probes as organization-less system probes', async () => {
        const { service, prisma, systemProbeScheduler } = createService();
        prisma.probe.create.mockImplementation(
            ({ data }: { data: Record<string, unknown> }) =>
                Promise.resolve({ ...systemProbeRow, ...data }),
        );

        const result = await service.create({
            name: 'Global Tokyo probe',
            provider: 'TENCENT',
            region: 'ap-northeast-1',
            callbackUrl: 'https://probe.example.com/beacon/callback',
            maxTenants: 100,
            priority: 10,
        });

        expect(prisma.probe.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                scope: 'SYSTEM',
                organizationId: null,
                name: 'Global Tokyo probe',
                enabled: true,
                maxTenants: 100,
                priority: 10,
            }),
        });
        expect(result.organizationId).toBeNull();
        expect(result.scope).toBe('SYSTEM');
        expect(result.secret).toMatch(/^sys_[0-9a-f]{64}$/);
        expect(systemProbeScheduler.rebalance).toHaveBeenCalledTimes(1);
    });

    it('lists only system probes ordered by priority', async () => {
        const { service, prisma } = createService();
        prisma.probe.findMany.mockResolvedValue([systemProbeRow]);

        const result = await service.findAll();

        expect(prisma.probe.findMany).toHaveBeenCalledWith({
            where: { scope: 'SYSTEM' },
            orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        });
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('system-probe-1');
    });

    it('rejects non-system or missing probes', async () => {
        const { service, prisma } = createService();
        prisma.probe.findFirst.mockResolvedValue(null);

        await expect(service.findOne('probe-1')).rejects.toThrow(
            NotFoundException,
        );
        expect(prisma.probe.findFirst).toHaveBeenCalledWith({
            where: { id: 'probe-1', scope: 'SYSTEM' },
        });
    });

    it('disables a system probe and marks it offline', async () => {
        const { service, prisma, systemProbeScheduler } = createService();
        prisma.probe.findFirst.mockResolvedValue(systemProbeRow);
        prisma.probe.update.mockResolvedValue({
            ...systemProbeRow,
            enabled: false,
        });

        const result = await service.toggle('system-probe-1', false);

        expect(prisma.probe.update).toHaveBeenCalledWith({
            where: { id: 'system-probe-1' },
            data: { enabled: false, status: 'OFFLINE' },
        });
        expect(result.enabled).toBe(false);
        expect(systemProbeScheduler.rebalance).toHaveBeenCalledTimes(1);
    });

    it('keeps status untouched when enabling a system probe', async () => {
        const { service, prisma } = createService();
        prisma.probe.findFirst.mockResolvedValue(systemProbeRow);
        prisma.probe.update.mockResolvedValue(systemProbeRow);

        await service.toggle('system-probe-1', true);

        expect(prisma.probe.update).toHaveBeenCalledWith({
            where: { id: 'system-probe-1' },
            data: { enabled: true, status: undefined },
        });
    });
});
