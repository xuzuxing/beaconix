import type { Job } from 'bullmq';
import type { CheckerService } from './checker.service';
import { MonitorCheckProcessor } from './monitor-check.processor';

function createProcessor() {
    const checkerService = { executeMonitor: jest.fn() };

    return {
        processor: new MonitorCheckProcessor(
            checkerService as unknown as CheckerService,
        ),
        checkerService,
    };
}

function createJob(monitorId: string) {
    return { data: { monitorId } } as Job<{ monitorId: string }>;
}

describe('MonitorCheckProcessor', () => {
    it('runs the check of the enqueued monitor', async () => {
        const { processor, checkerService } = createProcessor();

        await processor.process(createJob('monitor-1'));

        expect(checkerService.executeMonitor).toHaveBeenCalledWith('monitor-1');
    });

    it('keeps draining the queue when a check fails', async () => {
        const { processor, checkerService } = createProcessor();
        checkerService.executeMonitor.mockRejectedValue(new Error('db down'));

        await expect(
            processor.process(createJob('monitor-1')),
        ).resolves.toBeUndefined();
    });
});
