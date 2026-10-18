import type { Job } from 'bullmq';
import type { CheckerService } from './checker.service';
import { MonitorCheckProcessor } from './monitor-check.processor';
import { MonitorSettleProcessor } from './monitor-settle.processor';
import { MONITOR_CHECK_JOB, MONITOR_SETTLE_JOB } from './checker.queue';
import type {
    MonitorCheckJobData,
    MonitorSettleJobData,
} from './checker.queue';

function createProcessor() {
    const checkerService = {
        executeMonitor: jest.fn(),
        settleRound: jest
            .fn()
            .mockResolvedValue({ outcome: 'SETTLED', execution: null }),
    };

    return {
        processor: new MonitorCheckProcessor(
            checkerService as unknown as CheckerService,
            new MonitorSettleProcessor(
                checkerService as unknown as CheckerService,
            ),
        ),
        checkerService,
    };
}

function createJob(monitorId: string) {
    return {
        name: MONITOR_CHECK_JOB,
        data: { monitorId },
    } as Job<MonitorCheckJobData>;
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

    it('routes batch deadline jobs to the settlement consumer', async () => {
        const { processor, checkerService } = createProcessor();

        await processor.process({
            name: MONITOR_SETTLE_JOB,
            data: {
                monitorId: 'monitor-1',
                roundId: 'monitor-1:1700000000000',
            },
        } as Job<MonitorSettleJobData>);

        expect(checkerService.settleRound).toHaveBeenCalledWith(
            'monitor-1',
            'monitor-1:1700000000000',
            { force: true },
        );
        expect(checkerService.executeMonitor).not.toHaveBeenCalled();
    });

    it('ignores unknown job names', async () => {
        const { processor, checkerService } = createProcessor();

        await processor.process({
            name: 'something-else',
            data: { monitorId: 'monitor-1' },
        } as Job<MonitorCheckJobData>);

        expect(checkerService.executeMonitor).not.toHaveBeenCalled();
        expect(checkerService.settleRound).not.toHaveBeenCalled();
    });
});
