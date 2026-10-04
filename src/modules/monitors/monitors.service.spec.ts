import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MonitorsService } from './monitors.service';
import type { PrismaService } from '../../database/prisma.service';

const monitorRow = {
    id: 'monitor-1',
    organizationId: 'org-1',
    projectId: 'project-1',
    name: 'Production API',
    type: 'HTTP',
    target: 'https://api.example.com/health',
    interval: 60,
    timeout: 5000,
    expectedStatus: 200,
    failureThreshold: 3,
    enabled: true,
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
    deletedAt: null,
};

const projectRow = {
    id: 'project-1',
    organizationId: 'org-1',
    name: 'Platform',
    description: null,
    status: 'ACTIVE',
    key: 'PLAT',
    createdById: 'user-1',
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
    deletedAt: null,
};

const stateRow = {
    monitorId: 'monitor-1',
    status: 'UP',
    failCount: 0,
    lastCheckAt: null,
    lastError: null,
    lastLatency: 128,
    lastNotifiedStatus: null,
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
};

function createService() {
    const prisma = {
        monitor: {
            create: jest.fn(),
            findMany: jest.fn(),
            findFirst: jest.fn(),
            update: jest.fn(),
        },
        project: { findFirst: jest.fn().mockResolvedValue(projectRow) },
    };

    const service = new MonitorsService(prisma as unknown as PrismaService);

    return { service, prisma };
}

describe('MonitorsService', () => {
    describe('create', () => {
        it('creates the companion state row and flattens it into the response', async () => {
            const { service, prisma } = createService();
            prisma.monitor.create.mockResolvedValue({
                ...monitorRow,
                state: stateRow,
            });

            const result = await service.create('project-1', {
                name: 'Production API',
                type: 'HTTP',
                target: 'https://api.example.com/health',
            });

            expect(prisma.monitor.create).toHaveBeenCalledWith({
                data: {
                    name: 'Production API',
                    type: 'HTTP',
                    target: 'https://api.example.com/health',
                    organizationId: 'org-1',
                    projectId: 'project-1',
                    state: { create: {} },
                },
                include: { state: true },
            });
            expect(result.status).toBe('UP');
            expect(result.lastLatency).toBe(128);
            expect(result).not.toHaveProperty('state');
        });

        it('rejects an HTTP target without an http(s) scheme', async () => {
            const { service, prisma } = createService();

            await expect(
                service.create('project-1', {
                    name: 'Production API',
                    type: 'HTTP',
                    target: 'api.example.com/health',
                }),
            ).rejects.toThrow(BadRequestException);
            expect(prisma.monitor.create).not.toHaveBeenCalled();
        });

        it('rejects a TCP target without a valid port', async () => {
            const { service, prisma } = createService();

            await expect(
                service.create('project-1', {
                    name: 'Database',
                    type: 'TCP',
                    target: 'db.internal:not-a-port',
                }),
            ).rejects.toThrow(BadRequestException);
            expect(prisma.monitor.create).not.toHaveBeenCalled();
        });
    });

    describe('update', () => {
        it('resets state when the target changes', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: stateRow,
            });
            prisma.monitor.update.mockResolvedValue({
                ...monitorRow,
                target: 'https://api.example.com/ready',
                state: { ...stateRow, status: 'UNKNOWN', failCount: 0 },
            });

            await service.update('project-1', 'monitor-1', {
                target: 'https://api.example.com/ready',
            });

            expect(prisma.monitor.update).toHaveBeenCalledWith({
                where: { id: 'monitor-1' },
                data: {
                    target: 'https://api.example.com/ready',
                    state: {
                        upsert: {
                            create: {},
                            update: {
                                status: 'UNKNOWN',
                                failCount: 0,
                                lastCheckAt: null,
                                lastError: null,
                                lastLatency: null,
                                lastNotifiedStatus: null,
                            },
                        },
                    },
                },
                include: { state: true },
            });
        });

        it('does not reset state for metadata-only changes', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: stateRow,
            });
            prisma.monitor.update.mockResolvedValue({
                ...monitorRow,
                name: 'Renamed API',
                state: stateRow,
            });

            await service.update('project-1', 'monitor-1', {
                name: 'Renamed API',
            });

            expect(prisma.monitor.update).toHaveBeenCalledWith({
                where: { id: 'monitor-1' },
                data: {
                    name: 'Renamed API',
                    state: undefined,
                },
                include: { state: true },
            });
        });
    });

    describe('findAll', () => {
        it('falls back to UNKNOWN when a monitor has no state row', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findMany.mockResolvedValue([
                { ...monitorRow, state: null },
            ]);

            const [result] = await service.findAll('project-1');

            expect(prisma.monitor.findMany).toHaveBeenCalledWith({
                where: { projectId: 'project-1', deletedAt: null },
                include: { state: true },
                orderBy: { createdAt: 'desc' },
            });
            expect(result.status).toBe('UNKNOWN');
            expect(result.failCount).toBe(0);
            expect(result.lastLatency).toBeNull();
        });
    });

    describe('pause / resume', () => {
        it('disables the monitor and marks its state PAUSED', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: stateRow,
            });
            prisma.monitor.update.mockResolvedValue({
                ...monitorRow,
                enabled: false,
                state: { ...stateRow, status: 'PAUSED' },
            });

            const result = await service.pause('project-1', 'monitor-1');

            expect(prisma.monitor.update).toHaveBeenCalledWith({
                where: { id: 'monitor-1' },
                data: {
                    enabled: false,
                    state: {
                        upsert: {
                            create: { status: 'PAUSED' },
                            update: { status: 'PAUSED' },
                        },
                    },
                },
                include: { state: true },
            });
            expect(result.enabled).toBe(false);
            expect(result.status).toBe('PAUSED');
        });

        it('rejects pausing an already paused monitor', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                enabled: false,
                state: stateRow,
            });

            await expect(
                service.pause('project-1', 'monitor-1'),
            ).rejects.toThrow(BadRequestException);
            expect(prisma.monitor.update).not.toHaveBeenCalled();
        });

        it('re-enables the monitor and resets its status to UNKNOWN', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                enabled: false,
                state: { ...stateRow, status: 'PAUSED' },
            });
            prisma.monitor.update.mockResolvedValue({
                ...monitorRow,
                state: { ...stateRow, status: 'UNKNOWN' },
            });

            const result = await service.resume('project-1', 'monitor-1');

            expect(prisma.monitor.update).toHaveBeenCalledWith({
                where: { id: 'monitor-1' },
                data: {
                    enabled: true,
                    state: {
                        upsert: { create: {}, update: { status: 'UNKNOWN' } },
                    },
                },
                include: { state: true },
            });
            expect(result.enabled).toBe(true);
        });
    });

    describe('restore', () => {
        it('rejects restoring a monitor that is not deleted', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: stateRow,
            });

            await expect(
                service.restore('project-1', 'monitor-1'),
            ).rejects.toThrow(BadRequestException);
        });
    });

    describe('tenant scoping', () => {
        it('throws when the monitor is not in the project', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue(null);

            await expect(
                service.findOne('project-1', 'monitor-1'),
            ).rejects.toThrow(NotFoundException);
        });
    });
});
