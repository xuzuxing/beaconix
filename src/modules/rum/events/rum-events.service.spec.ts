import { RumEventsService } from './rum-events.service';

describe('RumEventsService ingestion', () => {
    it('sanitizes event properties and increments named and total metrics', async () => {
        const tx = {
            rumEvent: { create: jest.fn().mockResolvedValue({ id: 'event' }) },
            rumMetricBucket: {
                upsert: jest.fn().mockResolvedValue({ id: 'bucket' }),
            },
        };
        const publicIngest = {
            withActiveApp: jest.fn((_key, _source, work) =>
                work(tx, { id: 'app-1' }),
            ),
        };
        const service = new RumEventsService(
            {} as never,
            {} as never,
            publicIngest as never,
        );

        await expect(
            service.report(
                {
                    publicKey: 'rum-key',
                    eventName: 'checkout',
                    page: 'https://example.com/pay?token=secret',
                    properties: {
                        token: 'secret',
                        nested: { password: 'hidden', value: 3 },
                    },
                },
                '127.0.0.1',
            ),
        ).resolves.toEqual({ accepted: true });

        expect(tx.rumEvent.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                page: 'https://example.com/pay',
                properties: {
                    token: '[REDACTED]',
                    nested: { password: '[REDACTED]', value: 3 },
                },
            }),
        });
        expect(tx.rumMetricBucket.upsert).toHaveBeenCalledTimes(2);
    });
});
