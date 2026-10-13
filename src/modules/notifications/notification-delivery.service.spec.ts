import { NotificationDeliveryService } from './notification-delivery.service';
import { EmailTemplate } from '../email/email.types';
import type { PrismaService } from '../../infra/database/prisma.service';
import type { EmailService } from '../email/email.service';
import type { NotificationStreamService } from './notification-stream.service';
import type { ScheduledJobRegistry } from '../../infra/scheduler/scheduled-job.registry';
import { NotificationAccessService } from './notification-access.service';
import { mockProjectAccess } from '../../common/authorization/access-test.fixture';
import type { NotificationAudience } from './notification-event';

function fixture(channel = 'EMAIL') {
    const job = {
        id: 'delivery',
        dedupKey: 'stable-key',
        channel,
        attempts: 0,
        payload: {
            template: EmailTemplate.NOTIFICATION,
            data: {
                to: 'user@example.test',
                title: 'Changed',
                body: 'Changed',
            },
            notificationId: 'notice',
            audience: {
                accessScope: 'ORGANIZATION',
                userId: 'user',
                organizationId: 'org',
            } as NotificationAudience,
        },
    };
    const prisma = {
        notificationDelivery: {
            findMany: jest.fn().mockResolvedValue([job]),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findFirst: jest.fn().mockResolvedValue(job),
        },
        notification: {
            findUnique: jest.fn().mockResolvedValue({
                id: 'notice',
                userId: 'user',
                type: 'TASK_UPDATED',
                title: 'Changed',
                accessScope: 'ORGANIZATION',
                organizationId: 'org',
                projectId: null,
            }),
        },
        user: {
            findFirst: jest
                .fn()
                .mockResolvedValue({ id: 'user', email: 'user@example.test' }),
        },
        membership: {
            findMany: jest.fn().mockResolvedValue([{ id: 'member' }]),
            findFirst: jest.fn().mockResolvedValue({ id: 'member' }),
        },
        $queryRaw: jest.fn().mockResolvedValue([]),
        $transaction: jest.fn(),
        invitation: {
            findFirst: jest.fn().mockResolvedValue({ id: 'invite' }),
            findMany: jest.fn().mockResolvedValue([]),
        },
    };
    prisma.$transaction.mockImplementation((work) => work(prisma));
    const email = { send: jest.fn().mockResolvedValue(undefined) };
    const streams = { emit: jest.fn().mockResolvedValue(undefined) };
    const registry = { register: jest.fn() };
    const service = new NotificationDeliveryService(
        prisma as unknown as PrismaService,
        email as unknown as EmailService,
        streams as unknown as NotificationStreamService,
        registry as unknown as ScheduledJobRegistry,
        new NotificationAccessService(
            prisma as never,
            mockProjectAccess(prisma, 'org'),
        ),
    );
    return { service, prisma, email, streams, registry, job };
}

describe('Notification delivery worker', () => {
    it('skips queued SSE after membership or account eligibility is lost', async () => {
        const { service, prisma, streams } = fixture('SSE');
        prisma.user.findFirst.mockResolvedValue(null);
        await service.processPending();
        expect(prisma.user.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'user',
                isActive: true,
                deletedAt: null,
            },
            select: { id: true, email: true },
        });
        expect(streams.emit).not.toHaveBeenCalled();
        expect(
            prisma.notificationDelivery.updateMany.mock.calls.at(-1)![0].data
                .status,
        ).toBe('SKIPPED');
    });

    it('keeps explicit cross-org invitation and removal delivery eligible', async () => {
        const { service, prisma, streams, job } = fixture('SSE');
        Object.assign(job.payload.audience, {
            accessScope: 'ACCOUNT',
            organizationId: undefined,
        });
        prisma.notification.findUnique.mockResolvedValue({
            id: 'notice',
            userId: 'user',
            type: 'MEMBER_REMOVED',
            accessScope: 'ACCOUNT',
            organizationId: null,
            projectId: null,
        });
        await service.processPending();
        expect(prisma.user.findFirst).toHaveBeenCalledWith({
            where: { id: 'user', isActive: true, deletedAt: null },
            select: { id: true, email: true },
        });
        expect(streams.emit).toHaveBeenCalledTimes(1);
    });

    it('claims delivery and uses the stable email idempotency key', async () => {
        const { service, prisma, email, job } = fixture();
        await service.processPending();
        expect(prisma.notificationDelivery.updateMany.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                where: expect.objectContaining({ id: 'delivery' }),
                data: expect.objectContaining({
                    status: 'SENDING',
                    attempts: { increment: 1 },
                    leaseToken: expect.any(String),
                }),
            }),
        );
        expect(email.send).toHaveBeenCalledWith(
            EmailTemplate.NOTIFICATION,
            job.payload.data,
            'stable-key',
        );
        expect(
            prisma.notificationDelivery.updateMany.mock.calls.at(-1)![0],
        ).toEqual(
            expect.objectContaining({
                where: {
                    id: 'delivery',
                    leaseToken: expect.any(String),
                    status: 'SENDING',
                    leaseUntil: { gt: expect.any(Date) },
                },
                data: expect.objectContaining({
                    status: 'SENT',
                    deliveredAt: expect.any(Date),
                }),
            }),
        );
    });

    it('does not deliver a job claimed by a different replica', async () => {
        const { service, prisma, email } = fixture();
        prisma.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
        await service.processPending();
        expect(email.send).not.toHaveBeenCalled();
    });

    it('retries failures without persisting secret error messages', async () => {
        const { service, prisma, email } = fixture();
        email.send.mockRejectedValue(new Error('credential=do-not-log'));
        await service.processPending();
        expect(
            prisma.notificationDelivery.updateMany.mock.calls.at(-1)![0].data,
        ).toEqual(
            expect.objectContaining({
                status: 'PENDING',
                availableAt: expect.any(Date),
                lastError: 'Delivery failed; retry scheduled',
                leaseToken: null,
            }),
        );
    });

    it('rechecks current membership and skips removed or inactive recipients', async () => {
        const { service, prisma, email } = fixture();
        prisma.user.findFirst.mockResolvedValue(null);
        await service.processPending();
        expect(prisma.user.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'user',
                isActive: true,
                deletedAt: null,
                emailVerified: true,
            },
            select: { id: true, email: true },
        });
        expect(email.send).not.toHaveBeenCalled();
        expect(
            prisma.notificationDelivery.updateMany.mock.calls.at(-1)![0].data,
        ).toEqual(
            expect.objectContaining({
                status: 'SKIPPED',
                deliveredAt: null,
            }),
        );
    });

    it('skips revoked or elapsed invitation emails', async () => {
        const { service, prisma, email, job } = fixture();
        job.payload.template = EmailTemplate.INVITATION;
        Object.assign(job.payload.audience, {
            accessScope: 'INVITATION',
            invitationId: 'invite',
            email: 'user@example.test',
        });
        Object.assign(job.payload.data, { token: 'private-token' });
        prisma.invitation.findFirst.mockResolvedValue(null);
        await service.processPending();
        expect(prisma.invitation.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'invite',
                organizationId: 'org',
                email: { equals: 'user@example.test', mode: 'insensitive' },
                status: 'PENDING',
                expiresAt: { gt: expect.any(Date) },
                organization: { deletedAt: null },
            },
            select: { id: true },
        });
        expect(email.send).not.toHaveBeenCalled();
        expect(
            prisma.notificationDelivery.updateMany.mock.calls.at(-1)![0].data
                .status,
        ).toBe('SKIPPED');
    });

    it('emits an SSE event and never exposes the internal deduplication key', async () => {
        const { service, prisma, streams } = fixture('SSE');
        prisma.notification.findUnique.mockResolvedValue({
            id: 'notice',
            userId: 'user',
            type: 'TASK_UPDATED',
            dedupKey: 'internal',
            accessScope: 'ORGANIZATION',
            organizationId: 'org',
            projectId: null,
        });
        await service.processPending();
        expect(streams.emit).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'notice' }),
        );
        expect(streams.emit.mock.calls[0][0]).not.toHaveProperty('dedupKey');
    });

    it('projects invitation expiry at SSE delivery time', async () => {
        const { service, prisma, streams } = fixture('SSE');
        prisma.notification.findUnique.mockResolvedValue({
            id: 'notice',
            userId: 'user',
            type: 'INVITATION_RECEIVED',
            resourceType: 'Invitation',
            resourceId: 'invite',
            meta: { invitationStatus: 'PENDING', actionable: true },
            accessScope: 'ORGANIZATION',
            organizationId: 'org',
            projectId: null,
        });
        prisma.invitation.findMany.mockResolvedValue([
            {
                id: 'invite',
                status: 'PENDING',
                expiresAt: new Date(0),
                organization: { deletedAt: null },
            },
        ]);
        await service.processPending();
        expect(streams.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                meta: expect.objectContaining({
                    invitationStatus: 'EXPIRED',
                    actionable: false,
                }),
            }),
        );
    });

    it('skips SSE for a notice deleted before dispatch', async () => {
        const { service, prisma, streams } = fixture('SSE');
        prisma.notification.findUnique.mockResolvedValue(null);
        await service.processPending();
        expect(streams.emit).not.toHaveBeenCalled();
        expect(
            prisma.notificationDelivery.updateMany.mock.calls.at(-1)![0].data
                .status,
        ).toBe('SKIPPED');
    });

    it('prevents overlapping polls in the same process', async () => {
        const { service, prisma } = fixture();
        let release!: (value: []) => void;
        prisma.notificationDelivery.findMany.mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const first = service.processPending();
        await service.processPending();
        expect(prisma.notificationDelivery.findMany).toHaveBeenCalledTimes(1);
        release([]);
        await first;
    });

    it.each(['EMAIL', 'SSE'])(
        'cannot start %s after losing the dispatch lease',
        async (channel) => {
            const { service, prisma, email, streams } = fixture(channel);
            prisma.notificationDelivery.updateMany
                .mockResolvedValueOnce({ count: 1 })
                .mockResolvedValueOnce({ count: 1 })
                .mockResolvedValueOnce({ count: 0 });
            await service.processPending();
            expect(email.send).not.toHaveBeenCalled();
            expect(streams.emit).not.toHaveBeenCalled();
            expect(
                prisma.notificationDelivery.updateMany,
            ).toHaveBeenCalledTimes(3);
            expect(
                prisma.notificationDelivery.updateMany.mock.calls[2][0].where,
            ).toMatchObject({
                leaseToken: expect.any(String),
                status: 'SENDING',
                leaseUntil: { gt: expect.any(Date) },
                dispatchAuthorizedAt: { not: null },
            });
        },
    );

    it('renews SSE lease only after asynchronous payload projection completes', async () => {
        const { service, prisma, streams } = fixture('SSE');
        prisma.notification.findUnique.mockResolvedValue({
            id: 'notice',
            userId: 'user',
            type: 'INVITATION_RECEIVED',
            resourceType: 'Invitation',
            resourceId: 'invite',
            accessScope: 'ORGANIZATION',
            organizationId: 'org',
            projectId: null,
        });
        await service.processPending();
        expect(
            prisma.invitation.findMany.mock.invocationCallOrder[0],
        ).toBeLessThan(
            prisma.notificationDelivery.updateMany.mock.invocationCallOrder[2],
        );
        expect(
            prisma.notificationDelivery.updateMany.mock.invocationCallOrder[2],
        ).toBeLessThan(streams.emit.mock.invocationCallOrder[0]);
    });
});
