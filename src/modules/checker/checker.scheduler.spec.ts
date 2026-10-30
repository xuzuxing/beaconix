import { CheckerScheduler } from './checker.scheduler';
import {
    MONITOR_SCAN_INTERVAL_MS,
    MONITOR_SCAN_JOB,
    MONITOR_SCAN_SCHEDULER_ID,
} from './checker.queue';

function createScheduler() {
    const queue = {
        getJobScheduler: jest.fn().mockResolvedValue(undefined),
        upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    };

    return { scheduler: new CheckerScheduler(queue as never), queue };
}

describe('CheckerScheduler', () => {
    it('registers the recurring scan job through the job scheduler', async () => {
        const { scheduler, queue } = createScheduler();

        await scheduler.onModuleInit();

        expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
            MONITOR_SCAN_SCHEDULER_ID,
            { every: MONITOR_SCAN_INTERVAL_MS },
            expect.objectContaining({ name: MONITOR_SCAN_JOB }),
        );
    });

    it('does not fail the application boot when the scheduler cannot be registered', async () => {
        const { scheduler, queue } = createScheduler();
        queue.upsertJobScheduler.mockRejectedValue(new Error('redis down'));

        await expect(scheduler.onModuleInit()).resolves.toBeUndefined();
    });
});
