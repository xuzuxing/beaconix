import type { Job } from 'bullmq';
import { ScheduledJobRegistry } from './scheduled-job.registry';
import { SCHEDULED_JOBS } from './scheduled-jobs.constants';
import { ScheduledJobsProcessor } from './scheduled-jobs.processor';

function createProcessor() {
    const handler = jest.fn().mockResolvedValue(undefined);
    const registry = {
        get: jest.fn().mockReturnValue({
            name: SCHEDULED_JOBS.invitationExpiry,
            pattern: '0 * * * *',
            handler,
        }),
    };

    return {
        processor: new ScheduledJobsProcessor(
            registry as unknown as ScheduledJobRegistry,
        ),
        registry,
        handler,
    };
}

function createJob(name: string) {
    return { name } as Job;
}

describe('ScheduledJobsProcessor', () => {
    it('runs the handler registered for the job', async () => {
        const { processor, handler } = createProcessor();

        await processor.process(createJob(SCHEDULED_JOBS.invitationExpiry));

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('skips a job without a registered handler', async () => {
        const { processor, registry, handler } = createProcessor();
        registry.get.mockReturnValue(undefined);

        await expect(
            processor.process(createJob('some-removed-job')),
        ).resolves.toBeUndefined();
        expect(handler).not.toHaveBeenCalled();
    });
});
