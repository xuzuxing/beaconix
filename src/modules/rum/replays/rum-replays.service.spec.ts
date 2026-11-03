import { RumReplaysService } from './rum-replays.service';

describe('RumReplaysService ingestion', () => {
    function setup(inserted: number) {
        const tx = {
            rumReplaySession: {
                upsert: jest.fn().mockResolvedValue({ id: 'replay-1' }),
                update: jest.fn().mockResolvedValue({ id: 'replay-1' }),
            },
            rumReplayChunk: {
                createMany: jest.fn().mockResolvedValue({ count: inserted }),
            },
        };
        const publicIngest = {
            withActiveApp: jest.fn((_key, _source, work) =>
                work(tx, { id: 'app-1' }),
            ),
        };
        const service = new RumReplaysService(
            {} as never,
            {} as never,
            publicIngest as never,
            {
                get: () => ({ replayMaxPayloadBytes: 65_536 }),
            } as never,
        );
        return { service, tx };
    }

    it('increments session counters only for a new sequence', async () => {
        const { service, tx } = setup(1);
        await expect(
            service.report(
                {
                    publicKey: 'rum-key',
                    sessionId: 'session-1234',
                    sequence: 0,
                    events: [{ type: 'input', data: { password: 'secret' } }],
                    startedAt: '2026-11-03T00:00:00.000Z',
                    occurredAt: '2026-11-03T00:00:01.000Z',
                },
                '127.0.0.1',
            ),
        ).resolves.toEqual({ accepted: true, duplicate: false });
        expect(tx.rumReplaySession.update).toHaveBeenCalled();
        expect(tx.rumReplayChunk.createMany).toHaveBeenCalledWith({
            data: [
                expect.objectContaining({
                    events: [
                        {
                            type: 'input',
                            data: { password: '[REDACTED]' },
                        },
                    ],
                }),
            ],
            skipDuplicates: true,
        });
    });

    it('treats duplicate sequences as idempotent', async () => {
        const { service, tx } = setup(0);
        await service.report(
            {
                publicKey: 'rum-key',
                sessionId: 'session-1234',
                sequence: 0,
                events: [{ type: 'click' }],
                startedAt: '2026-11-03T00:00:00.000Z',
                occurredAt: '2026-11-03T00:00:01.000Z',
            },
            '127.0.0.1',
        );
        expect(tx.rumReplaySession.update).not.toHaveBeenCalled();
    });

    it('paginates chunks strictly after the supplied sequence', async () => {
        const prisma = {
            rumApp: {
                findFirst: jest.fn().mockResolvedValue({ id: 'app-1' }),
            },
            rumReplaySession: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'replay-1',
                    appId: 'app-1',
                }),
            },
            rumReplayChunk: {
                findMany: jest
                    .fn()
                    .mockResolvedValue([{ sequence: 3 }, { sequence: 4 }]),
            },
        };
        const access = {
            project: jest.fn().mockResolvedValue({ organizationId: 'org-1' }),
        };
        const service = new RumReplaysService(
            prisma as never,
            access as never,
            {} as never,
            {
                get: () => ({ replayMaxPayloadBytes: 65_536 }),
            } as never,
        );

        await expect(
            service.chunks(
                'project-1',
                'app-1',
                'replay-1',
                { afterSequence: 2, limit: 50 },
                { type: 'USER', userId: 'user-1' } as never,
            ),
        ).resolves.toEqual({
            items: [{ sequence: 3 }, { sequence: 4 }],
            nextSequence: 4,
        });
        expect(prisma.rumReplayChunk.findMany).toHaveBeenCalledWith({
            where: {
                sessionId: 'replay-1',
                sequence: { gt: 2 },
            },
            orderBy: { sequence: 'asc' },
            take: 50,
        });
    });
});
