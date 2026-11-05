import { RumPerformanceIngestService } from './rum-performance-ingest.service';

describe('RumPerformanceIngestService', () => {
    function setup() {
        const tx = {
            rumPerfSample: {
                create: jest.fn().mockResolvedValue({ id: 'sample-1' }),
            },
            $executeRaw: jest.fn().mockResolvedValue(1),
        };
        const publicIngest = {
            withActiveApp: jest.fn(
                (
                    _key: string,
                    _source: string,
                    work: (tx: unknown, app: unknown) => Promise<unknown>,
                ) => work(tx, { id: 'app-1' }),
            ),
        };
        const service = new RumPerformanceIngestService(publicIngest as never);
        return { service, tx, publicIngest };
    }

    it('stores every sample and opens the hour bucket', async () => {
        const { service, tx } = setup();

        await expect(
            service.report(
                {
                    publicKey: 'rum-key',
                    samples: [
                        {
                            metric: 'LCP',
                            value: 2312,
                            page: '/dashboard',
                            release: '2.4.0',
                        },
                        {
                            metric: 'RESOURCE',
                            value: 120,
                            dimension: 'https://cdn.example.com/app.js',
                            success: false,
                        },
                    ],
                },
                '127.0.0.1',
            ),
        ).resolves.toEqual({ accepted: true, samples: 2 });

        expect(tx.rumPerfSample.create).toHaveBeenCalledTimes(2);
        expect(tx.rumPerfSample.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                appId: 'app-1',
                metric: 'LCP',
                value: 2312,
                rating: 'GOOD',
                page: '/dashboard',
                release: '2.4.0',
                success: true,
            }),
        });
        expect(tx.rumPerfSample.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                metric: 'RESOURCE',
                dimension: 'https://cdn.example.com/app.js',
                success: false,
            }),
        });
        expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    });

    it('keeps the reported rating when the SDK sends one', async () => {
        const { service, tx } = setup();

        await service.report(
            {
                publicKey: 'rum-key',
                samples: [{ metric: 'LCP', value: 2312, rating: 'POOR' }],
            },
            '127.0.0.1',
        );

        expect(tx.rumPerfSample.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ rating: 'POOR' }),
        });
    });
});
