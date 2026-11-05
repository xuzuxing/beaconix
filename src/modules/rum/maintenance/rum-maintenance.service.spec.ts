import { BadRequestException } from '@nestjs/common';
import {
    RumMaintenanceJobStatus,
    RumMaintenanceJobType,
} from '../../../generated/prisma/enums';
import { RumMaintenanceService } from './rum-maintenance.service';

describe('RumMaintenanceService', () => {
    function setup(options: { mockSweep?: boolean } = {}) {
        const prisma = {
            rumApp: {
                findFirst: jest.fn().mockResolvedValue({ id: 'app-1' }),
            },
            rumMaintenanceJob: {
                create: jest
                    .fn()
                    .mockImplementation(({ data }) =>
                        Promise.resolve({ id: 'job-1', ...data }),
                    ),
                findMany: jest.fn().mockResolvedValue([]),
                findFirst: jest.fn().mockResolvedValue(null),
                findUnique: jest.fn().mockResolvedValue(null),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                update: jest.fn().mockResolvedValue({}),
            },
            rumReplaySession: {
                deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            $executeRawUnsafe: jest.fn().mockResolvedValue(10),
            $executeRaw: jest.fn().mockResolvedValue(2),
            $queryRaw: jest.fn().mockResolvedValue([]),
        };
        const access = {
            project: jest.fn().mockResolvedValue({ organizationId: 'org-1' }),
        };
        const registry = { register: jest.fn() };
        const service = new RumMaintenanceService(
            prisma as never,
            access as never,
            registry as never,
        );
        if (options.mockSweep) {
            // The request path schedules a best-effort sweep; keep it out of
            // the way while asserting only the queued job.
            jest.spyOn(service, 'processPending').mockResolvedValue(undefined);
        }
        return { service, prisma, access, registry };
    }

    const principal = { type: 'USER', userId: 'user-1' } as const;

    it('queues a purge job owned by the requesting app', async () => {
        const { service, prisma } = setup({ mockSweep: true });

        await service.requestPurge('project-1', 'app-1', principal);

        expect(prisma.rumMaintenanceJob.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                appId: 'app-1',
                organizationId: 'org-1',
                type: RumMaintenanceJobType.PURGE,
                requestedById: 'user-1',
            }),
        });
    });

    it('requires an end user or anonymous id for subject deletion', async () => {
        const { service } = setup({ mockSweep: true });

        await expect(
            service.requestSubjectDeletion('project-1', 'app-1', {}, principal),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('claims a pending job before executing it', async () => {
        const { service, prisma } = setup();
        prisma.rumMaintenanceJob.findMany.mockResolvedValue([{ id: 'job-1' }]);
        prisma.rumMaintenanceJob.findUnique.mockResolvedValue({
            id: 'job-1',
            appId: 'app-1',
            type: RumMaintenanceJobType.PURGE,
            payload: null,
        });

        await service.processPending();

        expect(prisma.rumMaintenanceJob.updateMany).toHaveBeenCalledWith({
            where: { id: 'job-1', status: RumMaintenanceJobStatus.PENDING },
            data: {
                status: RumMaintenanceJobStatus.RUNNING,
                startedAt: expect.any(Date),
            },
        });
        // One delete statement per table when the batch is not full.
        expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(7);
        expect(prisma.rumMaintenanceJob.update).toHaveBeenCalledWith({
            where: { id: 'job-1' },
            data: expect.objectContaining({
                status: RumMaintenanceJobStatus.COMPLETED,
                result: expect.any(Object),
            }),
        });
    });

    it('skips a job another replica already claimed', async () => {
        const { service, prisma } = setup();
        prisma.rumMaintenanceJob.findMany.mockResolvedValue([{ id: 'job-1' }]);
        prisma.rumMaintenanceJob.updateMany.mockResolvedValue({ count: 0 });

        await service.processPending();

        expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
        expect(prisma.rumMaintenanceJob.update).not.toHaveBeenCalled();
    });

    it('deletes subject data and the replays linked through session ids', async () => {
        const { service, prisma } = setup();
        prisma.$queryRaw
            .mockResolvedValueOnce([{ sessionId: 'session-1' }])
            .mockResolvedValueOnce([{ count: 3 }]);

        const result = await (
            service as unknown as {
                deleteSubject: (
                    appId: string,
                    payload: { endUserId: string },
                ) => Promise<Record<string, unknown>>;
            }
        ).deleteSubject('app-1', { endUserId: 'user-42' });

        expect(prisma.rumReplaySession.deleteMany).toHaveBeenCalledWith({
            where: { appId: 'app-1', sessionKey: { in: ['session-1'] } },
        });
        expect(result).toMatchObject({
            occurrences: 2,
            events: 2,
            perfSamples: 2,
            replaySessions: 1,
            unlinkedRecords: 3,
            aggregatesRetained: true,
        });
    });

    it('reports a failed job instead of throwing', async () => {
        const { service, prisma } = setup();
        prisma.rumMaintenanceJob.findMany.mockResolvedValue([{ id: 'job-1' }]);
        prisma.rumMaintenanceJob.findUnique.mockResolvedValue({
            id: 'job-1',
            appId: 'app-1',
            type: RumMaintenanceJobType.PURGE,
            payload: null,
        });
        prisma.$executeRawUnsafe.mockRejectedValue(new Error('boom'));

        await expect(service.processPending()).resolves.toBeUndefined();

        expect(prisma.rumMaintenanceJob.update).toHaveBeenCalledWith({
            where: { id: 'job-1' },
            data: expect.objectContaining({
                status: RumMaintenanceJobStatus.FAILED,
                error: expect.stringContaining('boom'),
            }),
        });
    });
});
