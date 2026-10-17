import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { PrismaService } from '../src/infra/database/prisma.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { NotificationDeliveryService } from '../src/modules/notifications/notification-delivery.service';
import { InvitationsService } from '../src/modules/invitations/invitations.service';
import { ProjectAccessService } from '../src/common/authorization/project-access.service';
import { NotificationAccessService } from '../src/modules/notifications/notification-access.service';
import type { NotificationEvent } from '../src/modules/notifications/notification-event';
import {
    addLocalMigrations,
    assertEmptyDatabase,
    deployMigrations,
    removeStagedMigrations,
    stageMigrations,
    validateTestUrl,
} from './monitor-postgres/harness';

void test('workspace notifications with real PostgreSQL transactions', async (t) => {
    const url = validateTestUrl(process.env.MONITOR_TEST_DATABASE_URL);
    const sql = new Client({
        connectionString: url,
        connectionTimeoutMillis: 5000,
    });
    let migrations: string | undefined;
    let prisma: PrismaService | undefined;
    try {
        await sql.connect();
        await assertEmptyDatabase(sql);
        migrations = await stageMigrations();
        await addLocalMigrations(migrations);
        await deployMigrations(url, migrations);
        await deployMigrations(url, migrations);
        prisma = new PrismaService(
            new ConfigService({
                database: { url },
                app: { isDevelopment: false },
            }),
        );
        await prisma.$connect();
        const db = prisma;
        const access = new ProjectAccessService(db);
        const authorization = new NotificationAccessService(db, access);
        const notifications = new NotificationsService(
            db,
            { kick: () => undefined } as never,
            {} as never,
            authorization,
            access,
        );
        const invitations = new InvitationsService(
            db,
            notifications,
            // Acceptance asks for the member quota; the invitation quota is
            // never consulted on this path.
            { assertCanAddMember: () => Promise.resolve() } as never,
            access,
        );
        for (const id of [
            'owner',
            'member',
            'invitee',
            'outsider',
            'inactive',
            'unverified',
        ]) {
            await db.user.create({
                data: {
                    id,
                    email: `${id}@example.test`,
                    name: id,
                    password: 'test-only',
                    emailVerified: id !== 'unverified',
                    isActive: id !== 'inactive',
                },
            });
        }
        await db.organization.create({
            data: { id: 'org', name: 'Team', slug: 'team', ownerId: 'owner' },
        });
        await db.project.create({
            data: {
                id: 'project',
                name: 'Notification fixture',
                key: 'NOTIFY',
                organizationId: 'org',
            },
        });
        await db.membership.createMany({
            data: [
                { userId: 'owner', organizationId: 'org', role: 'OWNER' },
                { userId: 'member', organizationId: 'org', role: 'MEMBER' },
                { userId: 'inactive', organizationId: 'org', role: 'MEMBER' },
            ],
        });
        const event: NotificationEvent = {
            eventKey: 'changed',
            type: 'TASK_UPDATED',
            title: 'Changed',
            organizationId: 'org',
            accessScope: 'ORGANIZATION',
            actorId: 'owner',
            recipients: ['owner', 'member', 'member', 'outsider', 'inactive'],
            email: true,
        };

        await t.test(
            'business mutation and both delivery intents roll back together',
            async () => {
                await assert.rejects(
                    db.$transaction(async (tx) => {
                        await tx.organization.update({
                            where: { id: 'org' },
                            data: { name: 'Uncommitted' },
                        });
                        await notifications.publish(event, tx);
                        throw new Error('abort transaction');
                    }),
                    /abort transaction/,
                );
                assert.equal(
                    (
                        await db.organization.findUniqueOrThrow({
                            where: { id: 'org' },
                        })
                    ).name,
                    'Team',
                );
                assert.equal(await db.notification.count(), 0);
                assert.equal(await db.notificationDelivery.count(), 0);
            },
        );

        await t.test(
            'concurrent replay produces one notice and one intent per channel',
            async () => {
                await Promise.all([
                    notifications.publish(event),
                    notifications.publish(event),
                    notifications.publish(event),
                ]);
                assert.equal(await db.notification.count(), 1);
                assert.equal(await db.notificationDelivery.count(), 2);
                assert.equal(
                    (await db.notification.findFirstOrThrow()).userId,
                    'member',
                );
            },
        );

        await t.test(
            'deleted notifications are not recreated by repeated publication',
            async () => {
                const notice = await db.notification.findFirstOrThrow();
                await notifications.remove('member', notice.id);
                await notifications.publish(event);
                assert.equal(await db.notification.count(), 0);
                assert.equal(await db.notificationDelivery.count(), 2);
            },
        );

        await t.test(
            'retains monitor recovery audience after ignoring the opening',
            async () => {
                const openingKey = 'monitor-incident:incident:OPEN';
                await notifications.publish({
                    ...event,
                    eventKey: openingKey,
                    type: 'MONITOR_ALERT',
                    recipients: ['member'],
                    email: false,
                });
                const notice = await db.notification.findFirstOrThrow({
                    where: { type: 'MONITOR_ALERT' },
                });
                await notifications.remove('member', notice.id);
                const audience =
                    await notifications.eventRecipients(openingKey);
                assert.deepEqual(audience, ['member']);
                await notifications.publish({
                    ...event,
                    eventKey: 'monitor-incident:incident:RECOVERY',
                    type: 'MONITOR_RECOVERED',
                    recipients: audience,
                    email: false,
                });
                assert.equal(
                    await db.notification.count({
                        where: { userId: 'member', type: 'MONITOR_RECOVERED' },
                    }),
                    1,
                );
            },
        );

        let inviteId = '';
        await t.test(
            'sending creates a cross-org station notice and durable invitation email',
            async () => {
                const invitation = await invitations.send('org', 'owner', {
                    email: 'INVITEE@example.test',
                    role: 'MEMBER',
                    projects: [{ projectId: 'project', role: 'MEMBER' }],
                });
                inviteId = invitation.id;
                const notice = await db.notification.findFirstOrThrow({
                    where: { userId: 'invitee', type: 'INVITATION_RECEIVED' },
                });
                assert.equal(notice.resourceId, inviteId);
                assert.equal(
                    JSON.stringify(notice.meta).includes('token'),
                    false,
                );
                assert.equal(
                    (await invitations.findPendingForUser('invitee')).length,
                    1,
                );
                await assert.rejects(
                    invitations.getById(inviteId, 'outsider'),
                    /another email/,
                );
                await assert.rejects(
                    invitations.acceptById(inviteId, 'unverified'),
                    /verified email/,
                );
            },
        );

        await t.test(
            'concurrent acceptance creates one membership and committed terminal state',
            async () => {
                const results = await Promise.allSettled([
                    invitations.acceptById(inviteId, 'invitee'),
                    invitations.acceptById(inviteId, 'invitee'),
                ]);
                assert.equal(
                    results.filter((result) => result.status === 'fulfilled')
                        .length,
                    1,
                );
                assert.equal(
                    await db.membership.count({
                        where: { userId: 'invitee', organizationId: 'org' },
                    }),
                    1,
                );
                const listed = await notifications.findAll('invitee', {});
                const received = listed.items.find(
                    (notice) => notice.type === 'INVITATION_RECEIVED',
                );
                assert.equal(received?.meta.invitationStatus, 'ACCEPTED');
                assert.equal(received?.meta.actionable, false);
                assert.equal(
                    await db.notification.count({
                        where: { userId: 'owner', type: 'INVITATION_ACCEPTED' },
                    }),
                    1,
                );
            },
        );

        await t.test(
            'verification discovers invitations created before registration verification',
            async () => {
                await invitations.send('org', 'owner', {
                    email: 'unverified@example.test',
                    role: 'VIEWER',
                    projects: [{ projectId: 'project', role: 'VIEWER' }],
                });
                assert.equal(
                    await db.notification.count({
                        where: { userId: 'unverified' },
                    }),
                    0,
                );
                await db.user.update({
                    where: { id: 'unverified' },
                    data: { emailVerified: true },
                });
                await notifications.syncPendingInvitations('unverified');
                await notifications.syncPendingInvitations('unverified');
                assert.equal(
                    await db.notification.count({
                        where: {
                            userId: 'unverified',
                            type: 'INVITATION_RECEIVED',
                        },
                    }),
                    1,
                );
            },
        );

        await t.test(
            'delivery worker skips deleted notices and processed invitations',
            async () => {
                const sent: string[] = [];
                const emitted: string[] = [];
                const worker = new NotificationDeliveryService(
                    db,
                    {
                        send: (template: string) => {
                            sent.push(template);
                            return Promise.resolve();
                        },
                    } as never,
                    {
                        emit: (notice: { id: string }) => {
                            emitted.push(notice.id);
                            return Promise.resolve();
                        },
                    } as never,
                    { register: () => undefined } as never,
                    authorization,
                );
                await worker.processPending();
                const jobs = await db.notificationDelivery.findMany();
                assert.ok(
                    jobs.some(
                        (job) => job.status === 'SKIPPED' && !job.deliveredAt,
                    ),
                );
                assert.ok(
                    jobs.some(
                        (job) => job.status === 'SENT' && job.deliveredAt,
                    ),
                );
                assert.ok(sent.length > 0);
                assert.ok(emitted.length > 0);
                assert.equal(
                    jobs.filter(
                        (job) =>
                            job.status === 'PENDING' ||
                            job.status === 'SENDING',
                    ).length,
                    0,
                );
            },
        );
    } finally {
        await prisma?.$disconnect();
        await sql.end();
        if (migrations) await removeStagedMigrations(migrations);
    }
});
