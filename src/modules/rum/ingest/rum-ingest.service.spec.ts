import { NotFoundException } from '@nestjs/common';
import { RumIngestService } from './rum-ingest.service';

describe('RumIngestService', () => {
    function setup(active = true) {
        const tx = {
            $queryRaw: jest.fn().mockResolvedValue([]),
            rumApp: {
                findFirst: jest
                    .fn()
                    .mockResolvedValue(active ? { id: 'app-1' } : null),
            },
            rumErrorGroup: {
                upsert: jest.fn().mockResolvedValue({ id: 'error-1' }),
            },
        };
        const prisma = {
            rumApp: {
                findUnique: jest.fn().mockResolvedValue({
                    id: 'app-1',
                    organizationId: 'org-1',
                    projectId: 'project-1',
                }),
            },
            $transaction: jest.fn((work) => work(tx)),
        };
        const rateLimit = { consume: jest.fn().mockResolvedValue(undefined) };
        return {
            service: new RumIngestService(prisma as never, rateLimit as never),
            prisma,
            rateLimit,
            tx,
        };
    }

    it('rechecks app state and atomically increments the error group', async () => {
        const { service, rateLimit, tx } = setup();
        await expect(
            service.reportError(
                {
                    publicKey: 'rum-key',
                    type: 'Error',
                    message: 'token=secret failed',
                    page: 'https://example.com/a?token=secret',
                },
                '127.0.0.1',
            ),
        ).resolves.toEqual({ accepted: true });

        expect(rateLimit.consume).toHaveBeenCalledWith('app-1', '127.0.0.1');
        expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
        expect(tx.rumErrorGroup.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    message: 'token=[REDACTED] failed',
                    page: 'https://example.com/a',
                }),
                update: expect.objectContaining({
                    count: { increment: 1 },
                }),
            }),
        );
    });

    it('rejects an app disabled before the locked state check', async () => {
        const { service, tx } = setup(false);
        await expect(
            service.reportError(
                {
                    publicKey: 'rum-key',
                    type: 'Error',
                    message: 'failed',
                },
                '127.0.0.1',
            ),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(tx.rumErrorGroup.upsert).not.toHaveBeenCalled();
    });
});
