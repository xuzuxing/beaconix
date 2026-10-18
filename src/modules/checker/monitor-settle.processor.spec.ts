import type { Job } from 'bullmq';
import type { CheckerService } from './checker.service';
import { MonitorSettleProcessor } from './monitor-settle.processor';
import type { MonitorSettleJobData } from './checker.queue';

function createSettleProcessor() {
    const checkerService = { settleRound: jest.fn() };

    return {
        processor: new MonitorSettleProcessor(
            checkerService as unknown as CheckerService,
        ),
        checkerService,
    };
}

function settleJob(
    monitorId = 'monitor-1',
    roundId = 'monitor-1:1700000000000',
) {
    return { data: { monitorId, roundId } } as Job<MonitorSettleJobData>;
}

describe('MonitorSettleProcessor', () => {
    it('forces the settlement of the batch at its deadline', async () => {
        const { processor, checkerService } = createSettleProcessor();
        checkerService.settleRound.mockResolvedValue({
            outcome: 'SETTLED',
            execution: null,
        });

        await processor.handle(settleJob());

        expect(checkerService.settleRound).toHaveBeenCalledWith(
            'monitor-1',
            'monitor-1:1700000000000',
            { force: true },
        );
    });

    it('treats a batch that already settled as a no-op', async () => {
        const { processor, checkerService } = createSettleProcessor();
        checkerService.settleRound.mockResolvedValue({
            outcome: 'DUPLICATE',
            execution: null,
        });

        await expect(processor.handle(settleJob())).resolves.toBeUndefined();
    });

    it('logs and swallows settlement failures', async () => {
        const { processor, checkerService } = createSettleProcessor();
        checkerService.settleRound.mockRejectedValue(new Error('db down'));

        await expect(processor.handle(settleJob())).resolves.toBeUndefined();
    });
});
