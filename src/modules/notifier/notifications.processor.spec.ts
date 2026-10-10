import { NotificationsProcessor } from './notifications.processor';
import type { NotifierService } from './notifier.service';
import type { StateService } from '../state/state.service';

const jobData = {
    channelId: 'channel-1',
    payload: {
        monitorId: 'monitor-1',
        monitorName: 'Production API',
        monitorType: 'HTTP',
        target: 'https://api.example.com/health',
        organizationId: 'org-1',
        previousStatus: 'UP',
        status: 'DOWN',
        event: 'DOWN',
        failCount: 3,
        latency: 30,
        error: 'connect ECONNREFUSED',
        checkedAt: new Date('2026-03-05T12:00:00.000Z'),
    },
    transitionStatus: 'DOWN',
    sslAlert: false,
} as const;

function createProcessor() {
    const notifierService = { deliver: jest.fn() };
    const stateService = {
        markNotified: jest.fn(),
        markSslNotified: jest.fn(),
    };

    const processor = new NotificationsProcessor(
        notifierService as unknown as NotifierService,
        stateService as unknown as StateService,
    );

    return { processor, notifierService, stateService };
}

describe('NotificationsProcessor', () => {
    it('does not mark stale notifications as delivered', async () => {
        const { processor, notifierService, stateService } = createProcessor();
        notifierService.deliver.mockResolvedValue(false);
        await processor.process({ data: jobData } as never);
        expect(stateService.markNotified).not.toHaveBeenCalled();
    });
    it('delivers the channel job and records the notified status', async () => {
        const { processor, notifierService, stateService } = createProcessor();
        notifierService.deliver.mockResolvedValue(undefined);

        await processor.process({ data: jobData } as never);

        expect(notifierService.deliver).toHaveBeenCalledWith(
            'channel-1',
            jobData.payload,
        );
        expect(stateService.markNotified).toHaveBeenCalledWith(
            'monitor-1',
            'DOWN',
            undefined,
        );
        expect(stateService.markSslNotified).not.toHaveBeenCalled();
    });

    it('records the SSL alert when the job is an SSL alert', async () => {
        const { processor, notifierService, stateService } = createProcessor();
        notifierService.deliver.mockResolvedValue(undefined);

        await processor.process({
            data: { ...jobData, sslAlert: true },
        } as never);

        expect(stateService.markSslNotified).toHaveBeenCalledWith(
            'monitor-1',
            undefined,
            undefined,
        );
    });
});
