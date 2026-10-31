import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { ScheduledJobRegistry } from './scheduled-job.registry';
import { SCHEDULED_JOBS } from './scheduled-jobs.constants';
import { ScheduledJobsRegistrar } from './scheduled-jobs.registrar';

function createRegistrar(timezone = '') {
    const queue = {
        getJobScheduler: jest.fn().mockResolvedValue(undefined),
        upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    };
    const registry = {
        list: jest.fn().mockReturnValue([
            {
                name: SCHEDULED_JOBS.invitationExpiry,
                pattern: '0 * * * *',
                handler: jest.fn(),
            },
            {
                name: SCHEDULED_JOBS.taskOverdue,
                pattern: '0 8 * * *',
                handler: jest.fn(),
            },
        ]),
    };
    const configService = { get: jest.fn().mockReturnValue({ timezone }) };

    return {
        registrar: new ScheduledJobsRegistrar(
            registry as unknown as ScheduledJobRegistry,
            queue as unknown as Queue,
            configService as unknown as ConfigService,
        ),
        queue,
        registry,
    };
}

describe('ScheduledJobsRegistrar', () => {
    it('upserts every registered schedule', async () => {
        const { registrar, queue } = createRegistrar();

        await registrar.onApplicationBootstrap();

        expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
        expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
            SCHEDULED_JOBS.invitationExpiry,
            { pattern: '0 * * * *' },
            expect.objectContaining({
                name: SCHEDULED_JOBS.invitationExpiry,
            }),
        );
    });

    it('applies the configured timezone to every schedule', async () => {
        const { registrar, queue } = createRegistrar('Asia/Shanghai');

        await registrar.onApplicationBootstrap();

        expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
            SCHEDULED_JOBS.taskOverdue,
            { pattern: '0 8 * * *', tz: 'Asia/Shanghai' },
            expect.anything(),
        );
    });

    it('keeps registering the remaining jobs when one fails', async () => {
        const { registrar, queue } = createRegistrar();
        queue.upsertJobScheduler.mockRejectedValueOnce(new Error('redis down'));

        await expect(
            registrar.onApplicationBootstrap(),
        ).resolves.toBeUndefined();
        expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
    });

    it('does nothing when no job is registered', async () => {
        const { registrar, queue, registry } = createRegistrar();
        registry.list.mockReturnValue([]);

        await registrar.onApplicationBootstrap();

        expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    });
});
