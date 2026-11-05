import { BadRequestException } from '@nestjs/common';
import { RumReleasesService } from './rum-releases.service';

describe('RumReleasesService', () => {
    function setup() {
        const prisma = {
            rumApp: {
                findFirst: jest.fn().mockResolvedValue({ id: 'app-1' }),
            },
            rumErrorGroup: {
                findMany: jest.fn().mockResolvedValue([]),
            },
            $queryRaw: jest.fn(),
        };
        const access = {
            project: jest.fn().mockResolvedValue({ organizationId: 'org-1' }),
        };
        return {
            service: new RumReleasesService(prisma as never, access as never),
            prisma,
            access,
        };
    }

    const principal = { type: 'USER', userId: 'user-1' } as const;

    it('merges error, event and replay volume per release', async () => {
        const { service, prisma } = setup();
        prisma.$queryRaw
            .mockResolvedValueOnce([
                {
                    release: '2.4.0',
                    firstSeen: new Date('2026-11-02T10:00:00.000Z'),
                    lastSeen: new Date('2026-11-02T12:00:00.000Z'),
                    errorGroups: 2,
                    occurrences: 9,
                },
                {
                    release: null,
                    firstSeen: new Date('2026-11-01T09:00:00.000Z'),
                    lastSeen: new Date('2026-11-01T09:30:00.000Z'),
                    errorGroups: 1,
                    occurrences: 3,
                },
            ])
            .mockResolvedValueOnce([
                {
                    release: '2.4.0',
                    firstSeen: new Date('2026-11-02T10:05:00.000Z'),
                    lastSeen: new Date('2026-11-02T11:00:00.000Z'),
                    events: 40,
                },
            ])
            .mockResolvedValueOnce([
                {
                    release: '2.4.0',
                    firstSeen: new Date('2026-11-02T10:10:00.000Z'),
                    lastSeen: new Date('2026-11-02T10:20:00.000Z'),
                    replays: 2,
                },
            ]);

        const result = await service.list('project-1', 'app-1', principal);

        expect(result.total).toBe(2);
        expect(result.items[0]).toMatchObject({
            release: '2.4.0',
            isUnknown: false,
            errorGroups: 2,
            occurrences: 9,
            events: 40,
            replays: 2,
        });
        // Reports without a release land in the unknown bucket.
        expect(result.items[1]).toMatchObject({
            release: null,
            isUnknown: true,
            errorGroups: 1,
            occurrences: 3,
            events: 0,
            replays: 0,
        });
        expect(result.items[0].firstSeenAt).toEqual(
            new Date('2026-11-02T10:00:00.000Z'),
        );
    });

    it('splits the fingerprint sets into new, fixed and regressed groups', async () => {
        const { service, prisma } = setup();
        prisma.$queryRaw.mockImplementation(
            (strings: TemplateStringsArray, ...values: unknown[]) => {
                const sql = strings.join('?');
                if (sql.includes('AS "value"')) {
                    return Promise.resolve([
                        { value: new Date('2026-11-02T00:00:00.000Z') },
                    ]);
                }
                if (sql.includes('< COALESCE')) {
                    return Promise.resolve([{ groupId: 'g-regressed' }]);
                }
                const release = values[1];
                if (release === '2.3.0') {
                    // The baseline already dropped g-regressed; only its
                    // predecessor release saw it, so it is a regression.
                    return Promise.resolve([
                        { groupId: 'g-base-only' },
                        { groupId: 'g-common' },
                    ]);
                }
                if (release === '2.4.0') {
                    return Promise.resolve([
                        { groupId: 'g-common' },
                        { groupId: 'g-new' },
                        { groupId: 'g-regressed' },
                    ]);
                }
                return Promise.resolve([]);
            },
        );
        prisma.rumErrorGroup.findMany.mockResolvedValue([
            { id: 'g-new', message: 'new' },
            { id: 'g-base-only', message: 'fixed' },
            { id: 'g-regressed', message: 'regressed' },
        ]);

        const result = await service.compare(
            'project-1',
            'app-1',
            '2.3.0',
            '2.4.0',
            principal,
        );

        expect(result.counts).toEqual({
            new: 2,
            fixed: 1,
            regressed: 1,
        });
        expect(result.new.map((group) => group.id).sort()).toEqual([
            'g-new',
            'g-regressed',
        ]);
        expect(result.fixed.map((group) => group.id)).toEqual(['g-base-only']);
        expect(result.regressed.map((group) => group.id)).toEqual([
            'g-regressed',
        ]);
    });

    it('treats an empty release as the unknown version', async () => {
        const { service, prisma } = setup();
        prisma.$queryRaw
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ groupId: 'g-unknown' }])
            .mockResolvedValueOnce([{ value: null }])
            .mockResolvedValueOnce([]);

        const result = await service.compare(
            'project-1',
            'app-1',
            '',
            '2.4.0',
            principal,
        );

        expect(result.base).toEqual({ release: null, isUnknown: true });
        expect(result.target).toEqual({ release: '2.4.0', isUnknown: false });
        expect(result.counts.new).toBe(1);
    });

    it('requires distinct base and target releases', async () => {
        const { service } = setup();
        await expect(
            service.compare('project-1', 'app-1', '2.4.0', '2.4.0', principal),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
            service.compare(
                'project-1',
                'app-1',
                undefined,
                '2.4.0',
                principal,
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});
