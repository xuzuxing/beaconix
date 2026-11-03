import { RumSourceMapsService } from './rum-source-maps.service';

describe('RumSourceMapsService symbolication', () => {
    it('resolves a browser stack frame for the matching release and artifact', async () => {
        const prisma = {
            rumSourceMap: {
                findMany: jest.fn().mockResolvedValue([
                    {
                        id: 'map-1',
                        artifactPath: '/assets/app.js',
                        content: JSON.stringify({
                            version: 3,
                            sources: ['src/main.ts'],
                            names: [],
                            mappings: 'AAAA',
                        }),
                        updatedAt: new Date('2026-11-03T00:00:00Z'),
                    },
                ]),
            },
        };
        const service = new RumSourceMapsService(
            prisma as never,
            {} as never,
            { get: () => ({ sourceMapMaxBytes: 1024 }) } as never,
        );

        await expect(
            service.symbolicate(
                'app-1',
                'release-1',
                'Error: failed\n    at run (https://example.com/assets/app.js:1:1)',
            ),
        ).resolves.toEqual({
            applied: true,
            stack: 'Error: failed\n    at run (src/main.ts:1:1)',
        });
    });
});
