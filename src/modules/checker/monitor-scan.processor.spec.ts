import type { CheckerService } from './checker.service';
import { MonitorScanProcessor } from './monitor-scan.processor';

function createProcessor() {
    const checkerService = {
        enqueueDueChecks: jest.fn().mockResolvedValue({ due: 2, enqueued: 2 }),
    };
    const checkQueue = { name: 'monitor-checks' };

    return {
        processor: new MonitorScanProcessor(
            checkerService as unknown as CheckerService,
            checkQueue as never,
        ),
        checkerService,
        checkQueue,
    };
}

describe('MonitorScanProcessor', () => {
    it('fans the due monitors out to the check queue', async () => {
        const { processor, checkerService, checkQueue } = createProcessor();

        await processor.process();

        expect(checkerService.enqueueDueChecks).toHaveBeenCalledWith(
            checkQueue,
        );
    });
});
