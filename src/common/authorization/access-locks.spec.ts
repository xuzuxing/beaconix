import { ConflictException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
    lockIdentities,
    lockMemberships,
    lockProjects,
    retryAccessTransaction,
} from './access-locks';

describe('Authorization transaction locks and retry boundaries', () => {
    it('locks identities in stable order and includes the PAT credential row', async () => {
        const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
        await lockIdentities(tx as never, [
            { type: 'USER', userId: 'z', patId: 'token' },
            { type: 'USER', userId: 'a' },
            { type: 'USER', userId: 'z' },
        ]);
        expect(tx.$queryRaw.mock.calls.map((call) => call[1])).toEqual([
            'a',
            'z',
            'token',
        ]);
        expect(tx.$queryRaw.mock.calls[2][0].join('')).toContain(
            '"personal_access_tokens"',
        );
    });
    it('selects the strongest membership lock once, without later upgrades', async () => {
        const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
        await lockMemberships(tx as never, [
            { id: 'z' },
            { id: 'a' },
            { id: 'z', update: true },
        ]);
        const queries = tx.$queryRaw.mock.calls.map(
            (call) => call[0] as Prisma.Sql,
        );
        expect(queries.map((query) => query.values[0])).toEqual(['a', 'z']);
        expect(queries[0].sql).toContain('FOR SHARE');
        expect(queries[1].sql).toContain('FOR UPDATE');
    });
    it('preserves the explicit project completion lock mode', async () => {
        const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
        await lockProjects(tx as never, ['z', 'a', 'a'], 'NO KEY UPDATE');
        const queries = tx.$queryRaw.mock.calls.map(
            (call) => call[0] as Prisma.Sql,
        );
        expect(queries.map((query) => query.values[0])).toEqual(['a', 'z']);
        expect(
            queries.every((query) => query.sql.includes('FOR NO KEY UPDATE')),
        ).toBe(true);
    });
    it.each(['P2034', 'P2010'])(
        'retries only recognized database conflicts, at most three attempts (%s)',
        async (code) => {
            const error = new Prisma.PrismaClientKnownRequestError('conflict', {
                code,
                clientVersion: 'test',
                meta: { code: '40P01' },
            });
            const run = jest.fn().mockRejectedValue(error);
            await expect(retryAccessTransaction(run)).rejects.toBe(error);
            expect(run).toHaveBeenCalledTimes(3);
        },
    );
    it('starts a fresh attempt and returns the successful result', async () => {
        const run = jest
            .fn()
            .mockRejectedValueOnce(
                new Prisma.PrismaClientKnownRequestError('conflict', {
                    code: 'P2034',
                    clientVersion: 'test',
                }),
            )
            .mockResolvedValue('committed');
        await expect(retryAccessTransaction(run)).resolves.toBe('committed');
        expect(run).toHaveBeenCalledTimes(2);
    });
    it.each([
        new ConflictException('stale membership'),
        new Error('network failure'),
        new Prisma.PrismaClientKnownRequestError('unique', {
            code: 'P2002',
            clientVersion: 'test',
        }),
        new Prisma.PrismaClientKnownRequestError('raw query', {
            code: 'P2010',
            clientVersion: 'test',
            meta: { code: '23503' },
        }),
    ])(
        'does not blindly retry business, integrity or external errors',
        async (error) => {
            const run = jest.fn().mockRejectedValue(error);
            await expect(retryAccessTransaction(run)).rejects.toBe(error);
            expect(run).toHaveBeenCalledTimes(1);
        },
    );
});
