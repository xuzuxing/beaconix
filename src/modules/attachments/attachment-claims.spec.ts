import { claimPersistedObjects, objectKeyFromUrl } from './attachment-claims';

function createDb(rows: Array<{ id: string; fileKey: string | null }>) {
    const findMany = jest.fn().mockResolvedValue(rows);
    const updateMany = jest.fn().mockResolvedValue({ count: rows.length });

    return {
        db: { attachment: { findMany, updateMany } } as never,
        findMany,
        updateMany,
    };
}

describe('objectKeyFromUrl', () => {
    it('reads the key out of a public static link', () => {
        expect(
            objectKeyFromUrl('/storage/public/avatars/2026/10/a-avatar.png'),
        ).toBe('avatars/2026/10/a-avatar.png');
        expect(
            objectKeyFromUrl(
                'https://api.example.com/storage/public/teams/2026/10/logo.png',
            ),
        ).toBe('teams/2026/10/logo.png');
    });

    it('reads the key out of an object endpoint link', () => {
        expect(
            objectKeyFromUrl(
                '/api/attachments/object?key=avatars%2F2026%2F10%2Fa.png',
            ),
        ).toBe('avatars/2026/10/a.png');
    });

    it('ignores URLs that own no local object', () => {
        expect(
            objectKeyFromUrl('https://thirdwx.qlogo.cn/mmopen/vi_32/abc/132'),
        ).toBeNull();
        expect(objectKeyFromUrl('')).toBeNull();
        expect(objectKeyFromUrl(null)).toBeNull();
    });

    it('never yields a private-space key', () => {
        expect(
            objectKeyFromUrl('/storage/public/tickets/2026/10/report.pdf'),
        ).toBeNull();
        expect(objectKeyFromUrl('avatars/../../secrets.png')).toBeNull();
    });
});

describe('claimPersistedObjects', () => {
    it('does nothing when no URL is given', async () => {
        const { db, findMany } = createDb([]);

        await expect(
            claimPersistedObjects(db, [undefined, null, '  ']),
        ).resolves.toBe(0);
        expect(findMany).not.toHaveBeenCalled();
    });

    it('marks the unhosted row behind a public URL as claimed', async () => {
        const { db, findMany, updateMany } = createDb([
            { id: 'attachment-1', fileKey: 'avatars/2026/10/a.png' },
        ]);

        const count = await claimPersistedObjects(db, [
            'https://api.example.com/storage/public/avatars/2026/10/a.png',
        ]);

        const where = findMany.mock.calls[0][0].where;
        expect(where).toMatchObject({
            claimedAt: null,
            taskId: null,
            ticketId: null,
            ticketReplyId: null,
        });
        expect(where.OR).toEqual([
            {
                url: {
                    in: [
                        'https://api.example.com/storage/public/avatars/2026/10/a.png',
                    ],
                },
            },
            { fileKey: { in: ['avatars/2026/10/a.png'] } },
        ]);
        expect(updateMany).toHaveBeenCalledWith({
            where: { id: { in: ['attachment-1'] }, claimedAt: null },
            data: { claimedAt: expect.any(Date) },
        });
        expect(count).toBe(1);
    });

    it('leaves private-space rows to their own host', async () => {
        const { db, updateMany } = createDb([
            { id: 'attachment-2', fileKey: 'tickets/2026/10/report.pdf' },
        ]);

        await expect(
            claimPersistedObjects(db, [
                '/storage/public/tickets/2026/10/report.pdf',
            ]),
        ).resolves.toBe(0);
        expect(updateMany).not.toHaveBeenCalled();
    });
});
