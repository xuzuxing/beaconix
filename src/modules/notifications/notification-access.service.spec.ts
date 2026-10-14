import { NotificationAccessService } from './notification-access.service';
import { ProjectAccessService } from '../../common/authorization/project-access.service';
import { ADMIN_NOTIFICATION_TYPES } from './notification-event';

function fixture() {
    const db = {
        user: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'user',
                email: 'user@example.test',
                globalRole: 'USER',
            }),
        },
        organization: {
            findMany: jest.fn().mockResolvedValue([{ id: 'org' }]),
        },
        membership: {
            findMany: jest
                .fn()
                .mockResolvedValue([
                    { id: 'member', organizationId: 'org', role: 'MEMBER' },
                ]),
            findFirst: jest.fn().mockResolvedValue({ id: 'member' }),
        },
        project: {
            findMany: jest
                .fn()
                .mockResolvedValue([{ id: 'a', organizationId: 'org' }]),
        },
        invitation: {
            findMany: jest.fn().mockResolvedValue([{ id: 'invite' }]),
        },
        $queryRaw: jest.fn().mockResolvedValue([]),
        $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation((work) => work(db));
    return {
        db,
        service: new NotificationAccessService(
            db as never,
            new ProjectAccessService(db as never),
        ),
    };
}

describe('Notification current access policy', () => {
    it('uses the same project scope for list/detail/count predicates without UNKNOWN fallback', async () => {
        const { db, service } = fixture();
        const where = await service.visibleWhere('user');
        expect(where).toEqual({
            userId: 'user',
            OR: [
                { accessScope: 'ACCOUNT' },
                {
                    accessScope: 'INVITATION',
                    resourceType: 'Invitation',
                    resourceId: { in: ['invite'] },
                },
                {
                    accessScope: 'ORGANIZATION',
                    organizationId: { in: ['org'] },
                    OR: [
                        { type: { notIn: ADMIN_NOTIFICATION_TYPES } },
                        { organizationId: { in: [] } },
                    ],
                },
                {
                    accessScope: 'PROJECT',
                    projectId: 'a',
                    organizationId: 'org',
                },
            ],
        });
        const query = db.project.findMany.mock.calls[0][0].where;
        expect(query.deletedAt).toBeNull();
        expect(query.organization).toEqual({ deletedAt: null });
        expect(query.OR).toContainEqual({
            memberships: {
                some: {
                    // ProjectMembership exposes no `organization` relation, so
                    // only the parent notification's organization guard applies.
                    membership: { userId: 'user' },
                },
            },
        });
        db.project.findMany.mockResolvedValue([]);
        const revoked = await service.visibleWhere('user');
        expect(revoked.OR).not.toContainEqual(
            expect.objectContaining({ accessScope: 'PROJECT' }),
        );
    });

    it('serializes notification writes and recomputes eligibility using the same transaction', async () => {
        const { db, service } = fixture();
        const work = jest.fn().mockResolvedValue('committed');
        await expect(service.withWrite('user', work)).resolves.toBe(
            'committed',
        );
        expect(work).toHaveBeenCalledWith(
            db,
            expect.objectContaining({ AND: expect.any(Array) }),
        );
        const sql = db.$queryRaw.mock.calls.map(([query]) =>
            Array.isArray(query) ? query.join('?') : query.sql,
        );
        expect(sql.map((value) => /FROM "(\w+)"/.exec(value)?.[1])).toEqual([
            'users',
            'organizations',
            'memberships',
            'projects',
        ]);
        expect(db.$queryRaw.mock.invocationCallOrder.at(-1)).toBeLessThan(
            work.mock.invocationCallOrder[0],
        );
        expect(db.user.findFirst).toHaveBeenCalledTimes(2);
        expect(db.project.findMany).toHaveBeenCalledTimes(2);
    });

    it('holds an empty predicate for inactive accounts and never queries projects', async () => {
        const { db, service } = fixture();
        db.user.findFirst.mockResolvedValue(null);
        const work = jest.fn().mockResolvedValue(null);
        await service.withWrite('user', work);
        expect(work).toHaveBeenCalledWith(db, {
            userId: 'user',
            id: { in: [] },
        });
        expect(db.project.findMany).not.toHaveBeenCalled();
    });

    it.each(['UNKNOWN', undefined])(
        'refuses ambiguous audience %s',
        async (accessScope) => {
            const { db, service } = fixture();
            expect(
                await service.eligible({
                    accessScope,
                    userId: 'user',
                } as never),
            ).toBe(false);
            expect(db.user.findFirst).not.toHaveBeenCalled();
        },
    );

    it('revalidates project grants and writable assignee role immediately before delivery', async () => {
        const { db, service } = fixture();
        const audience = {
            accessScope: 'PROJECT' as const,
            userId: 'user',
            organizationId: 'org',
            projectId: 'a',
            minimumRole: 'MEMBER' as const,
        };
        expect(await service.eligible(audience)).toBe(true);
        expect(db.membership.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    userId: 'user',
                    OR: expect.arrayContaining([
                        expect.objectContaining({
                            role: { in: ['MEMBER'] },
                            projectMemberships: {
                                some: {
                                    organizationId: 'org',
                                    projectId: 'a',
                                    role: { in: ['MEMBER', 'ADMIN'] },
                                    project: { deletedAt: null },
                                },
                            },
                        }),
                    ]),
                }),
            }),
        );
        db.membership.findFirst.mockResolvedValue(null);
        expect(await service.eligible(audience)).toBe(false);
    });

    it('rechecks organization administration for sensitive queued notices', async () => {
        const { db, service } = fixture();
        await service.eligible({
            accessScope: 'ORGANIZATION',
            userId: 'user',
            organizationId: 'org',
            organizationRoles: ['OWNER', 'ADMIN'],
        });
        expect(db.membership.findFirst.mock.calls[0][0].where.role).toEqual({
            in: ['OWNER', 'ADMIN'],
        });
    });
});
