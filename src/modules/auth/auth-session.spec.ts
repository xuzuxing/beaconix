import { createHash } from 'node:crypto';
import { AuthService } from './auth.service';

const NOW = +new Date('2026-10-31T00:00:00Z');
const hash = (value: string) =>
    createHash('sha256').update(value).digest('hex');

/** Serial, rollback-capable state fixture; real locking is checked in PostgreSQL. */
function fixture() {
    const user = {
        id: 'user',
        email: 'user@example.invalid',
        name: 'User',
        globalRole: 'USER',
        isActive: true,
        emailVerified: true,
        deletedAt: null as Date | null,
    };
    let tokens: any[] = [
        {
            id: 'root',
            userId: user.id,
            token: hash('original'),
            expiresAt: new Date(NOW + 86400000),
            revokedAt: null,
            familyId: null,
        },
    ];
    function matches(row: any, where: any) {
        return Object.entries(where).every(([key, value]: [string, any]) => {
            if (key === 'expiresAt') return row.expiresAt > value.gt;
            return row[key] === value;
        });
    }
    const prisma: any = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        user: { update: jest.fn().mockResolvedValue(user) },
        refreshToken: {
            findUnique: jest.fn((args) =>
                Promise.resolve().then(() => {
                    const row = tokens.find((token) =>
                        matches(token, args.where),
                    );
                    return row
                        ? structuredClone({
                              ...row,
                              ...(args.include?.user ? { user } : {}),
                          })
                        : null;
                }),
            ),
            updateMany: jest.fn((args) =>
                Promise.resolve().then(() => {
                    const rows = tokens.filter((token) =>
                        matches(token, args.where),
                    );
                    rows.forEach((row) => Object.assign(row, args.data));
                    return { count: rows.length };
                }),
            ),
            create: jest.fn((args) =>
                Promise.resolve().then(() => {
                    const row = {
                        id: `child-${tokens.length}`,
                        revokedAt: null,
                        ...args.data,
                    };
                    tokens.push(row);
                    return row;
                }),
            ),
        },
    };
    let tail = Promise.resolve<unknown>(null);
    prisma.$transaction = jest.fn((work) => {
        const result = tail.then(async () => {
            const before = structuredClone(tokens);
            try {
                return await work(prisma);
            } catch (error) {
                tokens = before;
                throw error;
            }
        });
        tail = result.catch(() => null);
        return result;
    });
    const jwt = { signAsync: jest.fn().mockResolvedValue('access') };
    const service = new AuthService(
        prisma,
        jwt as never,
        { get: () => ({ refreshExpiresIn: '7d' }) } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
    );
    return { service, prisma, jwt, user, rows: () => tokens };
}

describe('Atomic refresh sessions', () => {
    beforeEach(() => jest.useFakeTimers({ now: NOW }));
    afterEach(() => jest.useRealTimers());

    it('admits one rotation among concurrent requests and persists only hashed tokens', async () => {
        const f = fixture();
        const results = await Promise.allSettled(
            Array.from({ length: 8 }, () =>
                f.service.refresh({ refreshToken: 'original' }),
            ),
        );
        const winners = results.filter(
            (result) => result.status === 'fulfilled',
        );
        expect(winners).toHaveLength(1);
        expect(f.rows()).toHaveLength(2);
        expect(f.rows()[0]).toMatchObject({
            revokedAt: new Date(NOW),
            familyId: 'root',
        });
        const result = (winners[0] as PromiseFulfilledResult<any>).value;
        expect(f.rows()[1]).toMatchObject({
            token: hash(result.refreshToken),
            familyId: 'root',
            revokedAt: null,
        });
        expect(f.jwt.signAsync).toHaveBeenCalledTimes(1);
        await expect(
            f.service.refresh({ refreshToken: 'original' }),
        ).rejects.toThrow('revoked');
    });

    it.each(['sign', 'insert'])(
        'rolls back old-token consumption when %s fails',
        async (phase) => {
            const f = fixture();
            if (phase === 'sign')
                f.jwt.signAsync.mockRejectedValueOnce(
                    new Error('sign failure'),
                );
            else
                f.prisma.refreshToken.create.mockRejectedValueOnce(
                    new Error('insert failure'),
                );
            await expect(
                f.service.refresh({ refreshToken: 'original' }),
            ).rejects.toThrow('failure');
            expect(f.rows()).toHaveLength(1);
            expect(f.rows()[0].revokedAt).toBeNull();
            await expect(
                f.service.refresh({ refreshToken: 'original' }),
            ).resolves.toHaveProperty('refreshToken');
        },
    );

    it.each(['expired', 'boundary', 'revoked', 'inactive', 'deleted'])(
        'rejects %s sessions before issuing a replacement',
        async (state) => {
            const f = fixture();
            if (state === 'expired') f.rows()[0].expiresAt = new Date(NOW - 1);
            if (state === 'boundary') f.rows()[0].expiresAt = new Date(NOW);
            if (state === 'revoked') f.rows()[0].revokedAt = new Date(NOW - 1);
            if (state === 'inactive') f.user.isActive = false;
            if (state === 'deleted') f.user.deletedAt = new Date(NOW - 1);
            await expect(
                f.service.refresh({ refreshToken: 'original' }),
            ).rejects.toThrow();
            expect(f.jwt.signAsync).not.toHaveBeenCalled();
            expect(f.prisma.refreshToken.create).not.toHaveBeenCalled();
        },
    );

    it('revalidates the user after acquiring the lock', async () => {
        const f = fixture();
        f.prisma.$queryRaw.mockImplementation(() => {
            f.user.isActive = false;
            return Promise.resolve([]);
        });
        await expect(
            f.service.refresh({ refreshToken: 'original' }),
        ).rejects.toThrow('deactivated');
        expect(f.rows()[0].revokedAt).toBeNull();
    });

    it('honors the CAS result if another revocation has already consumed the token', async () => {
        const f = fixture();
        f.prisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 0 });
        await expect(
            f.service.refresh({ refreshToken: 'original' }),
        ).rejects.toThrow('revoked');
        expect(f.jwt.signAsync).not.toHaveBeenCalled();
    });

    it('logout revokes the current descendant while preserving other devices', async () => {
        const f = fixture();
        f.rows().push({
            ...f.rows()[0],
            id: 'device-2',
            token: hash('other-device'),
            familyId: 'other-family',
        });
        const first = await f.service.refresh({ refreshToken: 'original' });
        await f.service.refresh({ refreshToken: first.refreshToken });
        await f.service.logout({ refreshToken: 'original' });
        expect(
            f
                .rows()
                .filter((row) => !row.revokedAt)
                .map((row) => row.id),
        ).toEqual(['device-2']);
        await expect(
            f.service.refresh({ refreshToken: 'other-device' }),
        ).resolves.toHaveProperty('refreshToken');
    });

    it.each([true, false])(
        'refresh and logout cannot leave an active descendant (refreshFirst=%s)',
        async (refreshFirst) => {
            const f = fixture();
            await Promise.allSettled(
                refreshFirst
                    ? [
                          f.service.refresh({ refreshToken: 'original' }),
                          f.service.logout({ refreshToken: 'original' }),
                      ]
                    : [
                          f.service.logout({ refreshToken: 'original' }),
                          f.service.refresh({ refreshToken: 'original' }),
                      ],
            );
            expect(f.rows().filter((row) => !row.revokedAt)).toHaveLength(0);
        },
    );

    it('keeps unknown-token logout idempotent without opening a transaction', async () => {
        const f = fixture();
        await expect(
            f.service.logout({ refreshToken: 'unknown' }),
        ).resolves.toBeUndefined();
        await expect(
            f.service.refresh({ refreshToken: 'unknown' }),
        ).rejects.toThrow('Invalid refresh token');
        expect(f.prisma.$transaction).not.toHaveBeenCalled();
    });
});
