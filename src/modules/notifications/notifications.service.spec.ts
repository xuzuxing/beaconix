import { NotificationsService } from './notifications.service';
import { NotificationEntity } from './entities';
import { projectInvitationState } from './invitation-notification-state';
import type { PrismaService } from '../../infra/database/prisma.service';
import type { NotificationDeliveryService } from './notification-delivery.service';
import type { NotificationStreamService } from './notification-stream.service';
import type { NotificationDb, NotificationEvent } from './notification-event';
import { mockProjectAccess } from '../../common/authorization/access-test.fixture';

function fixture() {
    const notices = new Map<string, Record<string, unknown>>();
    const deliveries = new Map<string, Record<string, unknown>>();
    const db = {
        user: {
            findMany: jest.fn().mockImplementation(({ where }) =>
                Promise.resolve(
                    where.id.in.map((id: string) => ({
                        id,
                        email: `${id}@example.test`,
                        emailVerified: true,
                    })),
                ),
            ),
            findFirst: jest
                .fn()
                .mockResolvedValue({ email: 'invitee@example.test' }),
        },
        notification: {
            findUnique: jest
                .fn()
                .mockImplementation(({ where }) =>
                    Promise.resolve(notices.get(where.dedupKey) ?? null),
                ),
            upsert: jest.fn().mockImplementation(({ where, create }) => {
                const notice = notices.get(where.dedupKey) ?? {
                    id: `notice-${notices.size}`,
                    ...create,
                };
                notices.set(where.dedupKey, notice);
                return Promise.resolve(notice);
            }),
            findMany: jest.fn().mockResolvedValue([]),
            count: jest.fn().mockResolvedValue(0),
            findFirst: jest.fn().mockResolvedValue(null),
        },
        notificationDelivery: {
            findMany: jest.fn().mockResolvedValue([]),
            findUnique: jest
                .fn()
                .mockImplementation(({ where }) =>
                    Promise.resolve(deliveries.get(where.dedupKey) ?? null),
                ),
            createMany: jest.fn().mockImplementation(({ data }) => {
                let count = 0;
                for (const job of data) {
                    if (deliveries.has(job.dedupKey)) continue;
                    deliveries.set(job.dedupKey, job);
                    count++;
                }
                return Promise.resolve({ count });
            }),
            update: jest.fn().mockImplementation(({ where, data }) => {
                const job = { ...deliveries.get(where.dedupKey), ...data };
                deliveries.set(where.dedupKey, job);
                return Promise.resolve(job);
            }),
        },
        invitation: {
            findMany: jest.fn().mockResolvedValue([]),
            findUnique: jest.fn().mockResolvedValue({
                id: 'invite',
                organizationId: 'org',
                email: 'invitee@example.test',
            }),
        },
        membership: {
            findMany: jest.fn().mockResolvedValue([{ userId: 'recipient' }]),
        },
        task: { findUnique: jest.fn() },
        project: {
            findUnique: jest.fn(),
            findFirst: jest.fn().mockResolvedValue({ id: 'project' }),
        },
        $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation((work) => work(db));
    const delivery = { kick: jest.fn() };
    const streams = { getStream: jest.fn() };
    const authorization = {
        eligible: jest.fn().mockResolvedValue(true),
        visibleWhere: jest.fn().mockImplementation((userId) => ({
            userId,
            accessScope: { not: 'UNKNOWN' },
        })),
        withWrite: jest
            .fn()
            .mockImplementation((userId, work) =>
                db.$transaction((tx) =>
                    work(tx, { userId, accessScope: { not: 'UNKNOWN' } }),
                ),
            ),
    };
    const service = new NotificationsService(
        db as unknown as PrismaService,
        delivery as unknown as NotificationDeliveryService,
        streams as unknown as NotificationStreamService,
        authorization as never,
        mockProjectAccess(db, 'org'),
    );
    const event: NotificationEvent = {
        eventKey: 'mutation-1',
        type: 'TASK_UPDATED',
        title: 'Changed',
        recipients: ['recipient'],
        organizationId: 'org',
        actorId: 'actor',
        projectId: 'project',
    };
    return { service, db, delivery, notices, deliveries, event, authorization };
}

describe('NotificationsService transactional publishing', () => {
    it.each([
        ['PASSWORD_CHANGED', 'ACCOUNT', undefined],
        ['PASSWORD_RESET_COMPLETED', 'ACCOUNT', undefined],
        ['PERSONAL_ACCESS_TOKEN_CREATED', 'ACCOUNT', 'PersonalAccessToken'],
        ['PERSONAL_ACCESS_TOKEN_REVOKED', 'ACCOUNT', 'PersonalAccessToken'],
        ['API_KEY_CREATED', 'ORGANIZATION', 'ApiKey'],
        ['API_KEY_REVOKED', 'ORGANIZATION', 'ApiKey'],
        ['PROBE_ENROLLED', 'ORGANIZATION', 'Probe'],
        ['SUBSCRIPTION_ACTIVATED', 'ORGANIZATION', 'Subscription'],
        ['PAYMENT_SUCCEEDED', 'ORGANIZATION', 'Order'],
    ] as const)(
        'accepts explicitly scoped %s without rolling back its business transaction',
        async (type, accessScope, resourceType) => {
            const { service, event, notices, db, authorization } = fixture();
            await service.publish(
                {
                    ...event,
                    type,
                    accessScope,
                    resourceType,
                    resourceId: 'resource',
                    projectId: undefined,
                },
                db as never,
            );
            expect([...notices.values()][0].accessScope).toBe(accessScope);
            expect(db.$transaction).not.toHaveBeenCalled();
            if (accessScope === 'ORGANIZATION') {
                expect(authorization.eligible).toHaveBeenCalledWith(
                    expect.objectContaining({
                        organizationRoles: ['OWNER', 'ADMIN'],
                    }),
                    db,
                );
            }
        },
    );
    it('uses first recipient override and excludes the ordinary actor', async () => {
        const { service, db, event, notices } = fixture();
        await service.publish({
            ...event,
            recipients: [
                'actor',
                { userId: 'recipient', type: 'MENTION', title: 'Mentioned' },
                'recipient',
            ],
        });
        expect(db.user.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: { in: ['recipient'] },
                    isActive: true,
                    deletedAt: null,
                    memberships: { some: { organizationId: 'org' } },
                }),
            }),
        );
        expect([...notices.values()]).toEqual([
            expect.objectContaining({ type: 'MENTION', title: 'Mentioned' }),
        ]);
    });

    it('only persists eligible users returned by the tenant query', async () => {
        const { service, db, event, notices } = fixture();
        db.user.findMany.mockResolvedValue([]);
        await service.publish(event);
        expect(notices.size).toBe(0);
        expect(db.notificationDelivery.createMany).not.toHaveBeenCalled();
    });

    it('retains actor for security and permits explicit outside-org recipients', async () => {
        const { service, db, event } = fixture();
        await service.publish({
            ...event,
            recipients: ['actor'],
            includeActor: true,
            allowOutsideOrg: true,
            accessScope: 'ACCOUNT',
        });
        const where = db.user.findMany.mock.calls[0][0].where;
        expect(where.id.in).toEqual(['actor']);
        expect(where.memberships).toBeUndefined();
    });

    it('persists station and email intents in the supplied business transaction', async () => {
        const { service, db, delivery, event, deliveries } = fixture();
        await service.publish(
            { ...event, email: true },
            db as unknown as NotificationDb,
        );
        expect(db.$transaction).not.toHaveBeenCalled();
        expect(delivery.kick).not.toHaveBeenCalled();
        expect([...deliveries.values()].map((job) => job.channel)).toEqual([
            'SSE',
            'EMAIL',
        ]);
        expect([...deliveries.values()][1].payload).toEqual(
            expect.objectContaining({
                audience: {
                    accessScope: 'PROJECT',
                    userId: 'recipient',
                    organizationId: 'org',
                    projectId: 'project',
                    email: 'recipient@example.test',
                },
            }),
        );
    });

    it('creates a transaction and wakes delivery only after standalone persistence', async () => {
        const { service, db, delivery, event } = fixture();
        await service.publish(event);
        expect(db.$transaction).toHaveBeenCalledTimes(1);
        expect(delivery.kick).toHaveBeenCalledTimes(1);
    });

    it('deduplicates repeated events and never resurrects a deleted notice', async () => {
        const { service, event, notices, deliveries } = fixture();
        await service.publish({ ...event, email: true });
        await service.publish({ ...event, email: true });
        expect(notices.size).toBe(1);
        expect(deliveries.size).toBe(2);
        notices.clear();
        await service.publish(event);
        expect(notices.size).toBe(0);
        expect(deliveries.size).toBe(2);
    });

    it('removes secrets recursively and does not expose internal deduplication keys', async () => {
        const { service, event, notices } = fixture();
        await service.publish({
            ...event,
            meta: {
                token: 'hidden',
                nested: { password: 'hidden', targetId: 'allowed' },
                list: [{ apiSecret: 'hidden', value: 'allowed' }, null],
            },
        });
        const notice = [...notices.values()][0];
        expect(notice.meta).toEqual({
            organizationId: 'org',
            nested: { targetId: 'allowed' },
            list: [{ value: 'allowed' }, null],
        });
        expect(new NotificationEntity(notice)).not.toHaveProperty('dedupKey');
    });

    it('does not queue generic email for an unverified user', async () => {
        const { service, db, event, deliveries } = fixture();
        db.user.findMany.mockResolvedValue([
            {
                id: 'recipient',
                email: 'recipient@example.test',
                emailVerified: false,
            },
        ]);
        await service.publish({ ...event, email: true });
        expect([...deliveries.values()].map((job) => job.channel)).toEqual([
            'SSE',
        ]);
    });

    it('discovers pending invitations for a verified email using stable event IDs', async () => {
        const { service, db, notices, deliveries } = fixture();
        db.invitation.findMany.mockResolvedValue([
            {
                id: 'invite',
                organizationId: 'org',
                organization: { name: 'Team' },
                role: 'MEMBER',
                expiresAt: new Date(Date.now() + 86400_000),
            },
        ]);
        await service.syncPendingInvitations('invitee');
        await service.syncPendingInvitations('invitee');
        expect(db.invitation.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    email: {
                        equals: 'invitee@example.test',
                        mode: 'insensitive',
                    },
                    status: 'PENDING',
                    organization: { deletedAt: null },
                }),
            }),
        );
        expect(notices.size).toBe(1);
        expect(deliveries.size).toBe(1);
        expect([...notices.values()][0]).toEqual(
            expect.objectContaining({
                type: 'INVITATION_RECEIVED',
                resourceId: 'invite',
                meta: expect.objectContaining({ actionable: true }),
            }),
        );
    });

    it('does not sync invitations for unverified or inactive accounts', async () => {
        const { service, db } = fixture();
        db.user.findFirst.mockResolvedValue(null);
        await service.syncPendingInvitations('invitee');
        expect(db.invitation.findMany).not.toHaveBeenCalled();
    });

    it('only returns current members among task participants', async () => {
        const { service, db } = fixture();
        db.task.findUnique.mockResolvedValue({
            organizationId: 'org',
            createdById: 'departed',
            assignedToId: 'recipient',
            watchers: [{ userId: 'recipient' }, { userId: 'departed' }],
        });
        expect(await service.taskRecipients('task')).toEqual(['recipient']);
    });

    it('rejects attempts to mark another user notification as read', async () => {
        const { service, db } = fixture();
        await expect(
            service.markAsRead('user', 'other-notice'),
        ).rejects.toThrow('Notification not found');
        expect(db.notification.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'other-notice',
                userId: 'user',
                accessScope: { not: 'UNKNOWN' },
            },
        });
    });
});

describe('Notification lookup and durable event audience', () => {
    it('loads a single notification only within its owner scope', async () => {
        const { service, db } = fixture();
        db.notification.findFirst.mockResolvedValue({
            id: 'old-notice',
            userId: 'user',
        });
        const result = await service.findOne('user', 'old-notice');
        expect(result.id).toBe('old-notice');
        expect(db.notification.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'old-notice',
                userId: 'user',
                accessScope: { not: 'UNKNOWN' },
            },
        });
        db.notification.findFirst.mockResolvedValue(null);
        await expect(service.findOne('other', 'old-notice')).rejects.toThrow(
            'Notification not found',
        );
    });

    it('retains the original event audience after inbox dismissal', async () => {
        const { service, db, event, notices, deliveries } = fixture();
        await service.publish(event);
        notices.clear();
        db.notificationDelivery.findMany.mockResolvedValue(
            [...deliveries.values()].map((job) => ({
                payload: job.payload,
            })),
        );
        expect(await service.eventRecipients('mutation-1')).toEqual([
            'recipient',
        ]);
        expect(db.notificationDelivery.findMany).toHaveBeenCalledWith({
            where: {
                channel: 'SSE',
                payload: { path: ['eventKey'], equals: 'mutation-1' },
            },
            select: { payload: true },
        });
    });

    it('does not touch the inbox when the event was already reserved during replay', async () => {
        const { service, db, event } = fixture();
        db.notificationDelivery.createMany.mockImplementation(() =>
            Promise.resolve({ count: 0 }),
        );
        await service.publish(event);
        expect(db.notification.upsert).not.toHaveBeenCalled();
        expect(db.notificationDelivery.update).not.toHaveBeenCalled();
    });
});

describe('Invitation notification state projection', () => {
    it.each([
        [
            'expired',
            {
                status: 'PENDING',
                expiresAt: new Date(0),
                organization: { deletedAt: null },
            },
            'EXPIRED',
        ],
        [
            'revoked',
            {
                status: 'REVOKED',
                expiresAt: new Date(Date.now() + 10000),
                organization: { deletedAt: null },
            },
            'REVOKED',
        ],
        [
            'deleted team',
            {
                status: 'PENDING',
                expiresAt: new Date(Date.now() + 10000),
                organization: { deletedAt: new Date() },
            },
            'REVOKED',
        ],
        ['removed invitation', null, 'REVOKED'],
    ])('disables actions for %s', async (_name, invitation, status) => {
        const db = {
            invitation: {
                findMany: jest
                    .fn()
                    .mockResolvedValue(
                        invitation ? [{ id: 'invite', ...invitation }] : [],
                    ),
            },
        };
        const notice = new NotificationEntity({
            resourceType: 'Invitation',
            resourceId: 'invite',
            type: 'INVITATION_RECEIVED',
            meta: { invitationStatus: 'PENDING', actionable: true },
        });
        const [result] = await projectInvitationState(
            db as unknown as NotificationDb,
            [notice],
        );
        expect(result.meta).toEqual(
            expect.objectContaining({
                invitationStatus: status,
                actionable: false,
            }),
        );
    });
});
