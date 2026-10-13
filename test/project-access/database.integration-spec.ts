import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../src/generated/prisma/client';
import type { NotificationAudience } from '../../src/modules/notifications/notification-event';
import {
    acceptanceCase,
    aclMigration,
    addMigrations,
    connectDatabase,
    connectPrisma,
    deployLegacyBaseline,
    deployMigrations,
    HarnessFailure,
    openProjectAccessDatabases,
    removeStagedMigrations,
    root,
    safeAcceptance,
    stageLegacyMigrations,
    waitForDatabaseBlock,
    type SqlDatabase,
} from './harness';
import {
    businessServices,
    seedAccessFixture,
    seedLegacyFixture,
} from './fixtures';

async function rejectsSql(
    sql: SqlDatabase,
    statement: string,
    values: unknown[],
    state: string,
) {
    await assert.rejects(
        sql.query(statement, values),
        (error: unknown) =>
            error instanceof HarnessFailure && error.sqlState === state,
    );
}

void test(
    'project ACL fresh installation, legacy upgrade and real PostgreSQL transactions',
    {
        timeout: 240_000,
    },
    async (t) => {
        process.env.NODE_ENV = 'test';
        // All three catalogs must pass before staging/deploying either scenario.
        const harness = await openProjectAccessDatabases([
            'fresh',
            'upgrade',
            'http',
        ]);
        const fresh = harness.get('fresh');
        const upgrade = harness.get('upgrade');
        const directories: string[] = [];
        const prismaHandles: Awaited<ReturnType<typeof connectPrisma>>[] = [];
        let teardownFailed: boolean;
        try {
            await safeAcceptance('fresh and upgrade bootstrap', async () => {
                for (const sql of [fresh, upgrade]) {
                    const directory = await stageLegacyMigrations();
                    directories.push(directory);
                    await deployLegacyBaseline(sql.database, directory);
                }
                await seedLegacyFixture(upgrade);
                for (const [index, sql] of [fresh, upgrade].entries()) {
                    await addMigrations(directories[index], [aclMigration]);
                    await deployMigrations(sql.database, directories[index]);
                }
            });

            await acceptanceCase(
                t,
                'all historical, compatibility and ACL migrations are installed exactly once',
                async () => {
                    const expected = (
                        await readdir(join(root, 'prisma/migrations'), {
                            withFileTypes: true,
                        })
                    )
                        .filter((entry) => entry.isDirectory())
                        .map((entry) => entry.name)
                        .sort();
                    for (const [index, sql] of [fresh, upgrade].entries()) {
                        const before = await sql.query<{
                            migration_name: string;
                            finished_at: Date;
                            rolled_back_at: Date | null;
                        }>(
                            'SELECT migration_name,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name',
                        );
                        assert.deepEqual(
                            before.rows.map((row) => row.migration_name),
                            expected,
                        );
                        assert.ok(
                            before.rows.every(
                                (row) => row.finished_at && !row.rolled_back_at,
                            ),
                        );
                        await deployMigrations(
                            sql.database,
                            directories[index],
                        );
                        assert.deepEqual(
                            (
                                await sql.query(
                                    'SELECT migration_name,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name',
                                )
                            ).rows,
                            before.rows,
                        );
                    }
                },
            );

            const freshHandle = await connectPrisma(fresh.database);
            prismaHandles.push(freshHandle);
            const db = freshHandle.prisma;
            const fixture = await safeAcceptance('fresh fixtures', () =>
                seedAccessFixture(db),
            );
            const services = businessServices(db);

            await acceptanceCase(
                t,
                'composite grant foreign keys reject both cross-organization parents',
                async () => {
                    const insert =
                        'INSERT INTO project_memberships(id,"organizationId","membershipId","projectId",role,"updatedAt") VALUES ($1,$2,$3,$4,\'MEMBER\',CURRENT_TIMESTAMP)';
                    await rejectsSql(
                        fresh,
                        insert,
                        [
                            'bad-project-parent',
                            fixture.org.id,
                            fixture.memberMembership.id,
                            fixture.x.id,
                        ],
                        '23503',
                    );
                    await rejectsSql(
                        fresh,
                        insert,
                        [
                            'bad-membership-parent',
                            fixture.otherOrg.id,
                            fixture.memberMembership.id,
                            fixture.x.id,
                        ],
                        '23503',
                    );
                    const invitation = await db.invitation.create({
                        data: {
                            email: 'grant-fixture@example.invalid',
                            organizationId: fixture.org.id,
                            expiresAt: new Date(Date.now() + 86_400_000),
                            sentById: fixture.owner.id,
                            issuerType: 'ORGANIZATION',
                            issuerMembershipId: fixture.ownerMembership.id,
                        },
                    });
                    const grantInsert =
                        'INSERT INTO invitation_project_grants(id,"invitationId","organizationId","projectId",role) VALUES ($1,$2,$3,$4,\'VIEWER\')';
                    await rejectsSql(
                        fresh,
                        grantInsert,
                        [
                            'bad-invitation-project',
                            invitation.id,
                            fixture.org.id,
                            fixture.x.id,
                        ],
                        '23503',
                    );
                    await rejectsSql(
                        fresh,
                        grantInsert,
                        [
                            'bad-invitation-parent',
                            invitation.id,
                            fixture.otherOrg.id,
                            fixture.x.id,
                        ],
                        '23503',
                    );
                    await rejectsSql(
                        fresh,
                        insert,
                        [
                            'duplicate-grant',
                            fixture.org.id,
                            fixture.memberMembership.id,
                            fixture.b.id,
                        ],
                        '23505',
                    );
                },
            );

            await acceptanceCase(
                t,
                'issuer and notification CHECKs reject invalid combinations while permitting legacy defaults',
                async () => {
                    const invitation = await db.invitation.create({
                        data: {
                            email: 'legacy-check@example.invalid',
                            organizationId: fixture.org.id,
                            expiresAt: new Date(Date.now() + 86_400_000),
                            sentById: fixture.owner.id,
                        },
                    });
                    assert.equal(invitation.issuerType, 'LEGACY');
                    await rejectsSql(
                        fresh,
                        'UPDATE invitations SET "issuerType" = \'PLATFORM\', "issuerAuthorityVersion" = -1 WHERE id = $1',
                        [invitation.id],
                        '23514',
                    );
                    await rejectsSql(
                        fresh,
                        'UPDATE invitations SET "issuerType" = \'ORGANIZATION\' WHERE id = $1',
                        [invitation.id],
                        '23514',
                    );
                    const notification = await db.notification.create({
                        data: {
                            userId: fixture.member.id,
                            type: 'TASK_ASSIGNED',
                            title: 'Unclassified fixture',
                        },
                    });
                    assert.equal(notification.accessScope, 'UNKNOWN');
                    await rejectsSql(
                        fresh,
                        'UPDATE notifications SET "accessScope" = \'PROJECT\' WHERE id = $1',
                        [notification.id],
                        '23514',
                    );
                    await rejectsSql(
                        fresh,
                        'UPDATE notifications SET "accessScope" = \'ACCOUNT\', "organizationId" = $2 WHERE id = $1',
                        [notification.id, fixture.org.id],
                        '23514',
                    );
                    await rejectsSql(
                        fresh,
                        'UPDATE memberships SET "projectPermissionsVersion" = -1 WHERE id = $1',
                        [fixture.memberMembership.id],
                        '23514',
                    );
                },
            );

            await acceptanceCase(
                t,
                'platform authority trigger covers ORM, direct SQL, restoration and attempted resets',
                async () => {
                    const id = fixture.platform.id;
                    let version = fixture.platform.platformAuthorityVersion;
                    const changed = async (data: Prisma.UserUpdateInput) => {
                        const user = await db.user.update({
                            where: { id },
                            data,
                        });
                        assert.equal(user.platformAuthorityVersion, ++version);
                    };
                    await changed({
                        globalRole: 'USER',
                        platformAuthorityVersion: 0,
                    });
                    await changed({ isActive: false });
                    await changed({ deletedAt: new Date() });
                    await changed({ deletedAt: null });
                    await fresh.query(
                        'UPDATE users SET "globalRole" = \'SUPER_ADMIN\', "platformAuthorityVersion" = 0 WHERE id = $1',
                        [id],
                    );
                    assert.equal(
                        (await db.user.findUniqueOrThrow({ where: { id } }))
                            .platformAuthorityVersion,
                        ++version,
                    );
                    await fresh.query(
                        'UPDATE users SET "isActive" = true WHERE id = $1',
                        [id],
                    );
                    assert.equal(
                        (await db.user.findUniqueOrThrow({ where: { id } }))
                            .platformAuthorityVersion,
                        ++version,
                    );
                    const unchanged = await db.user.update({
                        where: { id },
                        data: {
                            name: 'Renamed platform user',
                            globalRole: 'SUPER_ADMIN',
                            platformAuthorityVersion: 0,
                        },
                    });
                    assert.equal(unchanged.platformAuthorityVersion, version);
                },
            );

            await acceptanceCase(
                t,
                'legacy upgrade does not grant projects or classify private historical data',
                async () => {
                    const handle = await connectPrisma(upgrade.database);
                    prismaHandles.push(handle);
                    const legacy = handle.prisma;
                    assert.equal(await legacy.projectMembership.count(), 0);
                    assert.equal(
                        await legacy.invitationProjectGrant.count(),
                        0,
                    );
                    const members = await legacy.membership.findMany();
                    assert.equal(members.length, 3);
                    assert.ok(
                        members.every(
                            (member) => member.projectPermissionsVersion === 0,
                        ),
                    );
                    const invitation =
                        await legacy.invitation.findUniqueOrThrow({
                            where: { id: 'legacy-invitation' },
                        });
                    assert.equal(invitation.issuerType, 'LEGACY');
                    assert.equal(invitation.status, 'REVOKED');
                    assert.equal(invitation.issuerMembershipId, null);
                    assert.equal(invitation.issuerAuthorityVersion, null);
                    assert.equal(
                        (
                            await legacy.notification.findUniqueOrThrow({
                                where: { id: 'legacy-notification' },
                            })
                        ).accessScope,
                        'UNKNOWN',
                    );
                    assert.equal(
                        (
                            await legacy.attachment.findUniqueOrThrow({
                                where: { id: 'legacy-attachment' },
                            })
                        ).visibility,
                        'UNKNOWN',
                    );
                    const real = businessServices(legacy);
                    for (const userId of ['legacy-member', 'legacy-viewer']) {
                        await assert.rejects(
                            real.access.project(
                                { type: 'USER', userId },
                                'legacy-project',
                            ),
                            NotFoundException,
                        );
                    }
                    assert.equal(
                        (
                            await real.access.project(
                                { type: 'USER', userId: 'legacy-owner' },
                                'legacy-project',
                            )
                        ).accessMode,
                        'ALL_PROJECTS',
                    );
                    assert.equal(
                        await real.authorization.eligible({
                            userId: 'legacy-member',
                            accessScope: 'UNKNOWN',
                        } as unknown as NotificationAudience),
                        false,
                    );
                    await assert.rejects(
                        real.attachments.getDownload(
                            'legacy-task',
                            'legacy-attachment',
                            { type: 'USER', userId: 'legacy-owner' },
                        ),
                        NotFoundException,
                    );
                },
            );

            await acceptanceCase(
                t,
                'invalid assignees produce no task, watcher, activity, notification or outbox writes',
                async () => {
                    await db.projectMembership.create({
                        data: {
                            membershipId: fixture.viewerMembership.id,
                            projectId: fixture.b.id,
                            role: 'VIEWER',
                            organizationId: fixture.org.id,
                        },
                    });
                    await db.user.update({
                        where: { id: fixture.assignee.id },
                        data: { isActive: false },
                    });
                    const before = await Promise.all([
                        db.task.count(),
                        db.taskWatcher.count(),
                        db.taskActivity.count(),
                        db.notification.count(),
                        db.notificationDelivery.count(),
                    ]);
                    for (const assignedToId of [
                        fixture.ungranted.id,
                        fixture.viewer.id,
                        fixture.assignee.id,
                    ]) {
                        await assert.rejects(
                            services.tasks.create(
                                fixture.b.id,
                                fixture.member.id,
                                {
                                    title: 'Must not persist',
                                    assignedToId,
                                },
                            ),
                            BadRequestException,
                        );
                        await assert.rejects(
                            services.tasks.assign(
                                fixture.b.id,
                                fixture.taskB.id,
                                fixture.member.id,
                                {
                                    assignedToId,
                                },
                            ),
                            BadRequestException,
                        );
                    }
                    assert.deepEqual(
                        await Promise.all([
                            db.task.count(),
                            db.taskWatcher.count(),
                            db.taskActivity.count(),
                            db.notification.count(),
                            db.notificationDelivery.count(),
                        ]),
                        before,
                    );
                    assert.equal(
                        (
                            await db.task.findUniqueOrThrow({
                                where: { id: fixture.taskB.id },
                            })
                        ).assignedToId,
                        null,
                    );
                    await db.user.update({
                        where: { id: fixture.assignee.id },
                        data: { isActive: true },
                    });
                },
            );

            await acceptanceCase(
                t,
                'real business write holds Membership SHARE until commit and serializes against ACL revocation',
                async () => {
                    const gate = await connectDatabase(fresh.database);
                    const other = await connectPrisma(fresh.database);
                    prismaHandles.push(other);
                    const revoke = businessServices(other.prisma).permissions;
                    let writer: Promise<unknown> | undefined;
                    let revoker: Promise<unknown> | undefined;
                    try {
                        await gate.query('BEGIN');
                        await gate.query(
                            'SELECT id FROM tasks WHERE id = $1 FOR UPDATE',
                            [fixture.taskB.id],
                        );
                        const gatePid = (
                            await gate.query<{ pid: number }>(
                                'SELECT pg_backend_pid() AS pid',
                            )
                        ).rows[0].pid;
                        writer = services.tasks.update(
                            fixture.b.id,
                            fixture.taskB.id,
                            fixture.member.id,
                            {
                                title: 'Committed before revoke',
                            },
                        );
                        // Attach rejection handlers immediately while both promises run.
                        const writerOutcome = writer.then(
                            (value) => ({ ok: true, value }),
                            () => ({ ok: false }),
                        );
                        await waitForDatabaseBlock(fresh, gatePid);
                        const blocked = await fresh.query<{ pid: number }>(
                            'SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',
                            [gatePid],
                        );
                        assert.equal(blocked.rows.length, 1);
                        const current = await db.membership.findUniqueOrThrow({
                            where: { id: fixture.memberMembership.id },
                        });
                        revoker = revoke.replace(
                            fixture.org.id,
                            fixture.member.id,
                            fixture.owner.id,
                            {
                                expectedMembershipId: current.id,
                                expectedVersion:
                                    current.projectPermissionsVersion,
                                projects: [],
                            },
                        );
                        const revokeOutcome = revoker.then(
                            (value) => ({ ok: true, value }),
                            () => ({ ok: false }),
                        );
                        await waitForDatabaseBlock(fresh, blocked.rows[0].pid);
                        await gate.query('COMMIT');
                        assert.equal((await writerOutcome).ok, true);
                        assert.equal((await revokeOutcome).ok, true);
                        assert.equal(
                            (
                                await db.task.findUniqueOrThrow({
                                    where: { id: fixture.taskB.id },
                                })
                            ).title,
                            'Committed before revoke',
                        );
                        assert.equal(
                            await db.projectMembership.count({
                                where: { membershipId: current.id },
                            }),
                            0,
                        );
                        assert.equal(
                            await db.auditLog.count({
                                where: {
                                    entity: 'ProjectPermissions',
                                    entityId: current.id,
                                },
                            }),
                            1,
                        );
                        await assert.rejects(
                            services.tasks.update(
                                fixture.b.id,
                                fixture.taskB.id,
                                fixture.member.id,
                                {
                                    title: 'Must not commit after revocation',
                                },
                            ),
                            NotFoundException,
                        );
                        assert.equal(
                            (
                                await db.task.findUniqueOrThrow({
                                    where: { id: fixture.taskB.id },
                                })
                            ).title,
                            'Committed before revoke',
                        );
                    } finally {
                        await gate.query('ROLLBACK').catch(() => undefined);
                        await Promise.allSettled(
                            [writer, revoker].filter(
                                (item): item is Promise<unknown> => !!item,
                            ),
                        );
                        await gate.close();
                    }
                },
            );

            await acceptanceCase(
                t,
                'attachment audit failure rolls metadata deletion back in PostgreSQL before physical cleanup',
                async () => {
                    await fresh.query(`
                CREATE FUNCTION project_access_acceptance_reject_attachment_audit()
                RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    RAISE EXCEPTION 'controlled acceptance audit failure' USING ERRCODE = '23514';
                END $$;
            `);
                    await fresh.query(`
                CREATE TRIGGER project_access_acceptance_attachment_audit_failure
                BEFORE INSERT ON audit_logs FOR EACH ROW
                WHEN (NEW.entity = 'Attachment')
                EXECUTE FUNCTION project_access_acceptance_reject_attachment_audit()
            `);
                    await assert.rejects(
                        services.attachments.remove(
                            fixture.taskB.id,
                            fixture.attachmentB.id,
                            fixture.owner.id,
                        ),
                        (error: unknown) => {
                            // Inspect locally, inside safeAcceptance; driver text never
                            // becomes assertion output or an attached raw cause.
                            const text =
                                error instanceof Error ? error.message : '';
                            const serialized = JSON.stringify(error);
                            return (
                                text.includes(
                                    'controlled acceptance audit failure',
                                ) ||
                                !!serialized?.includes(
                                    'controlled acceptance audit failure',
                                )
                            );
                        },
                    );
                    assert.ok(
                        await db.attachment.findUnique({
                            where: { id: fixture.attachmentB.id },
                        }),
                    );
                    assert.equal(
                        await db.auditLog.count({
                            where: {
                                entity: 'Attachment',
                                entityId: fixture.attachmentB.id,
                            },
                        }),
                        0,
                    );
                    assert.equal(services.deletedObjects.length, 0);
                },
            );
        } finally {
            const results = await Promise.allSettled([
                ...prismaHandles.map((handle) => handle.close()),
                ...directories.map((directory) =>
                    removeStagedMigrations(directory),
                ),
                harness.close(),
            ]);
            teardownFailed = results.some(
                (result) => result.status === 'rejected',
            );
        }
        if (teardownFailed) {
            throw new HarnessFailure(
                'Project-access acceptance teardown failed.',
            );
        }
    },
);
