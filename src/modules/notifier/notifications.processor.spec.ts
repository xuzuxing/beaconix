import { NotificationsProcessor } from './notifications.processor';
import {
    MONITOR_AVAILABILITY_JOB,
    MONITOR_TRANSITION_JOB,
} from './notifier.queue';
import type { NotificationPayload } from './notifier.types';
import { renderText } from './channel-message';
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
    const notifierService = {
        deliver: jest.fn(),
        deliverAlertDelivery: jest.fn(),
    };
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
    it.each([MONITOR_TRANSITION_JOB, MONITOR_AVAILABILITY_JOB])(
        'renders the serialized check date when delivering a %s job',
        async (name) => {
            const { processor, notifierService, stateService } =
                createProcessor();
            const payload = {
                ...jobData.payload,
                monitorRevision: 2,
                checkedAt: jobData.payload.checkedAt.toISOString(),
            };
            notifierService.deliver.mockImplementation(
                (_channelId: string, deliveredPayload: NotificationPayload) => {
                    expect(renderText(deliveredPayload)).toContain(
                        `Checked at: ${payload.checkedAt}`,
                    );
                    return Promise.resolve(true);
                },
            );

            await processor.process({
                name,
                data: { ...jobData, payload },
            } as never);

            expect(notifierService.deliver).toHaveBeenCalledWith(
                'channel-1',
                payload,
            );
            expect(payload.checkedAt).toBe(
                jobData.payload.checkedAt.toISOString(),
            );
            if (name === MONITOR_AVAILABILITY_JOB) {
                expect(stateService.markNotified).not.toHaveBeenCalled();
            } else {
                expect(stateService.markNotified).toHaveBeenCalledWith(
                    'monitor-1',
                    'DOWN',
                    2,
                );
            }
            expect(stateService.markSslNotified).not.toHaveBeenCalled();
        },
    );

    it('propagates delivery failures without marking status or SSL notifications', async () => {
        const { processor, notifierService, stateService } = createProcessor();
        notifierService.deliver.mockRejectedValue(new Error('HTTP 500'));

        await expect(
            processor.process({
                name: MONITOR_TRANSITION_JOB,
                data: {
                    ...jobData,
                    sslAlert: true,
                    payload: {
                        ...jobData.payload,
                        checkedAt: jobData.payload.checkedAt.toISOString(),
                    },
                },
            } as never),
        ).rejects.toThrow('HTTP 500');

        expect(stateService.markNotified).not.toHaveBeenCalled();
        expect(stateService.markSslNotified).not.toHaveBeenCalled();
    });

    it('keeps outbox deliveries on their existing delivery path', async () => {
        const { processor, notifierService, stateService } = createProcessor();

        await processor.process({
            data: { deliveryId: 'delivery-1' },
        } as never);

        expect(notifierService.deliverAlertDelivery).toHaveBeenCalledWith(
            'delivery-1',
        );
        expect(notifierService.deliver).not.toHaveBeenCalled();
        expect(stateService.markNotified).not.toHaveBeenCalled();
        expect(stateService.markSslNotified).not.toHaveBeenCalled();
    });

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
