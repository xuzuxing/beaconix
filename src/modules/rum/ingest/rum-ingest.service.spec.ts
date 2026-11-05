import { NotFoundException } from '@nestjs/common';
import { RumIngestService } from './rum-ingest.service';
import { RumPublicIngestService } from './rum-public-ingest.service';

describe('RumIngestService', () => {
    function setup(active = true) {
        const tx = {
            $queryRaw: jest.fn().mockResolvedValue([]),
            $executeRaw: jest.fn().mockResolvedValue(1),
            rumApp: {
                findFirst: jest.fn().mockResolvedValue(
                    active
                        ? {
                              id: 'app-1',
                              organizationId: 'org-1',
                              projectId: 'project-1',
                              name: 'Portal',
                          }
                        : null,
                ),
            },
            rumErrorGroup: {
                upsert: jest.fn().mockResolvedValue({ id: 'error-1' }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            rumErrorOccurrence: {
                findUnique: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue({ id: 'occurrence-1' }),
            },
            rumMetricBucket: {
                upsert: jest.fn().mockResolvedValue({ id: 'metric-1' }),
            },
        };
        const prisma = {
            rumApp: {
                findUnique: jest.fn().mockResolvedValue({
                    id: 'app-1',
                    organizationId: 'org-1',
                    projectId: 'project-1',
                    name: 'Portal',
                }),
            },
            $transaction: jest.fn((work) => work(tx)),
        };
        const rateLimit = { consume: jest.fn().mockResolvedValue(undefined) };
        const publicIngest = new RumPublicIngestService(
            prisma as never,
            rateLimit as never,
        );
        return {
            service: new RumIngestService(publicIngest, {
                symbolicate: (_appId, _release, stack) =>
                    Promise.resolve({ stack: stack ?? '', applied: false }),
            } as never),
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
        expect(tx.rumErrorOccurrence.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                appId: 'app-1',
                groupId: 'error-1',
                category: 'JAVASCRIPT',
                level: 'ERROR',
                message: 'token=[REDACTED] failed',
            }),
        });
    });

    it('accepts an already stored client event without incrementing twice', async () => {
        const { service, tx } = setup();
        tx.rumErrorOccurrence.findUnique.mockResolvedValue({
            id: 'occurrence-existing',
        });

        await expect(
            service.reportError(
                {
                    publicKey: 'rum-key',
                    clientEventId: 'event_duplicate_1',
                    type: 'Error',
                    message: 'failed',
                },
                '127.0.0.1',
            ),
        ).resolves.toEqual({ accepted: true });

        expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
        expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
        expect(tx.rumErrorOccurrence.findUnique).toHaveBeenCalledWith({
            where: {
                appId_clientEventId: {
                    appId: 'app-1',
                    clientEventId: 'event_duplicate_1',
                },
            },
            select: { id: true },
        });
        expect(tx.rumErrorGroup.upsert).not.toHaveBeenCalled();
        expect(tx.rumErrorOccurrence.create).not.toHaveBeenCalled();
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

    it('reopens an ignored group only once its ignore window elapsed', async () => {
        const { service, tx } = setup();

        await service.reportError(
            {
                publicKey: 'rum-key',
                type: 'Error',
                message: 'failed again',
            },
            '127.0.0.1',
        );

        expect(tx.rumErrorGroup.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'error-1',
                status: 'IGNORED',
                ignoredUntil: { lte: expect.any(Date) },
            },
            data: {
                status: 'UNRESOLVED',
                ignoredUntil: null,
                reopenedAt: expect.any(Date),
            },
        });
    });
});
