import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import * as bcrypt from 'bcrypt';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { PrismaService } from '../../src/infra/database/prisma.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { TokenCleanupService } from '../../src/modules/cron/jobs/token-cleanup.service';
import {
    assertEmptyDatabase,
    deployMigrations,
    root,
    validateTestUrl,
} from '../monitor-postgres/harness';

const hash = (value: string) =>
    createHash('sha256').update(value).digest('hex');

void test('session rotation, revocation and cleanup with real PostgreSQL', async (t) => {
    const url = validateTestUrl(process.env.MONITOR_TEST_DATABASE_URL);
    const sql = new Client({ connectionString: url });
    let db: PrismaService | undefined;
    try {
        await sql.connect();
        await assertEmptyDatabase(sql);
        await deployMigrations(url, join(root, 'prisma/migrations'));
        db = new PrismaService(
            new ConfigService({
                database: { url },
                app: { isDevelopment: false },
            }),
        );
        await db.$connect();
        const prisma = db;
        const password = await bcrypt.hash('old-password', 4);
        let sequence = 0;
        const cleanup = new TokenCleanupService(prisma, {} as never);
        async function fixture() {
            sequence++;
            const user = await prisma.user.create({
                data: {
                    name: 'Session fixture',
                    email: `session-${sequence}@example.invalid`,
                    password,
                    emailVerified: true,
                },
            });
            const raw = `root-${sequence}`;
            const rootToken = await prisma.refreshToken.create({
                data: {
                    userId: user.id,
                    token: hash(raw),
                    expiresAt: new Date(Date.now() + 86400000),
                },
            });
            let failSigning = false;
            let signingHook = () => Promise.resolve();
            const service = new AuthService(
                prisma,
                {
                    signAsync: () =>
                        signingHook().then(() =>
                            failSigning
                                ? Promise.reject(
                                      new Error('signing unavailable'),
                                  )
                                : Promise.resolve('access'),
                        ),
                } as never,
                new ConfigService({ jwt: { refreshExpiresIn: '7d' } }),
                {} as never,
                {} as never,
                {} as never,
                { publish: () => Promise.resolve() } as never,
            );
            return {
                user,
                raw,
                rootToken,
                service,
                failSigning: (value: boolean) => {
                    failSigning = value;
                },
                beforeSigning: (hook: () => Promise<void>) => {
                    signingHook = hook;
                },
                active: () =>
                    prisma.refreshToken.count({
                        where: { userId: user.id, revokedAt: null },
                    }),
            };
        }

        await t.test(
            'one concurrent refresh wins and the family contains one current token',
            async () => {
                const f = await fixture();
                const results = await Promise.allSettled(
                    Array.from({ length: 12 }, () =>
                        f.service.refresh({ refreshToken: f.raw }),
                    ),
                );
                assert.equal(
                    results.filter((r) => r.status === 'fulfilled').length,
                    1,
                );
                assert.equal(await f.active(), 1);
                const rows = await prisma.refreshToken.findMany({
                    where: { userId: f.user.id },
                });
                assert.equal(rows.length, 2);
                assert.ok(rows.every((row) => row.familyId === f.rootToken.id));
                const winner = results.find(
                    (r) => r.status === 'fulfilled',
                ) as PromiseFulfilledResult<{ refreshToken: string }>;
                assert.ok(
                    rows.some(
                        (row) => row.token === hash(winner.value.refreshToken),
                    ),
                );
                await assert.rejects(
                    f.service.refresh({ refreshToken: f.raw }),
                );
                await assert.rejects(
                    prisma.refreshToken.create({
                        data: {
                            userId: f.user.id,
                            token: 'direct-duplicate-family',
                            familyId: f.rootToken.id,
                            expiresAt: new Date(Date.now() + 86400000),
                        },
                    }),
                    (error: { code: string }) => error.code === 'P2002',
                );
            },
        );

        await t.test(
            'signing failure rolls back parent revocation and permits retry',
            async () => {
                const f = await fixture();
                f.failSigning(true);
                await assert.rejects(
                    f.service.refresh({ refreshToken: f.raw }),
                    /signing unavailable/,
                );
                assert.equal(
                    (
                        await prisma.refreshToken.findUniqueOrThrow({
                            where: { id: f.rootToken.id },
                        })
                    ).revokedAt,
                    null,
                );
                assert.equal(await f.active(), 1);
                f.failSigning(false);
                await f.service.refresh({ refreshToken: f.raw });
                assert.equal(await f.active(), 1);
            },
        );

        await t.test(
            'logout racing with refresh revokes descendants and preserves another device',
            async () => {
                for (let i = 0; i < 4; i++) {
                    const f = await fixture();
                    const other = await prisma.refreshToken.create({
                        data: {
                            userId: f.user.id,
                            token: `other-device-${i}`,
                            familyId: `other-family-${i}`,
                            expiresAt: new Date(Date.now() + 86400000),
                        },
                    });
                    await Promise.allSettled([
                        f.service.refresh({ refreshToken: f.raw }),
                        f.service.logout({ refreshToken: f.raw }),
                    ]);
                    const active = await prisma.refreshToken.findMany({
                        where: { userId: f.user.id, revokedAt: null },
                    });
                    assert.deepEqual(
                        active.map((row) => row.id),
                        [other.id],
                    );
                }
            },
        );

        await t.test(
            'password changes racing with refresh leave no refreshable child',
            async () => {
                const f = await fixture();
                const results = await Promise.allSettled([
                    f.service.refresh({ refreshToken: f.raw }),
                    f.service.changePassword(f.user.id, {
                        currentPassword: 'old-password',
                        newPassword: 'new-password',
                    }),
                ]);
                assert.equal(results[1].status, 'fulfilled');
                assert.equal(await f.active(), 0);
                await assert.rejects(
                    f.service.refresh({ refreshToken: f.raw }),
                );
            },
        );

        await t.test(
            'the 2FA user-lock revocation contract serializes with refresh',
            async () => {
                const f = await fixture();
                await Promise.allSettled([
                    f.service.refresh({ refreshToken: f.raw }),
                    prisma.$transaction(async (tx) => {
                        await tx.$queryRaw`SELECT id FROM users WHERE id = ${f.user.id} FOR UPDATE`;
                        await tx.user.update({
                            where: { id: f.user.id },
                            data: { twoFactorEnabled: true },
                        });
                        await tx.refreshToken.updateMany({
                            where: { userId: f.user.id, revokedAt: null },
                            data: { revokedAt: new Date() },
                        });
                    }),
                ]);
                assert.equal(await f.active(), 0);
            },
        );

        await t.test(
            'cleanup retains even expired ancestors of an active family until logout',
            async () => {
                const f = await fixture();
                const child = await f.service.refresh({ refreshToken: f.raw });
                await prisma.refreshToken.update({
                    where: { id: f.rootToken.id },
                    data: { expiresAt: new Date(Date.now() - 86400000) },
                });
                await cleanup.handleTokenCleanup();
                assert.ok(
                    await prisma.refreshToken.findUnique({
                        where: { id: f.rootToken.id },
                    }),
                );
                await f.service.logout({ refreshToken: f.raw });
                await assert.rejects(
                    f.service.refresh({ refreshToken: child.refreshToken }),
                );
                await cleanup.handleTokenCleanup();
                assert.equal(
                    await prisma.refreshToken.count({
                        where: { userId: f.user.id },
                    }),
                    0,
                );
            },
        );

        await t.test(
            'cleanup concurrent with rotation never loses the ancestor-to-family mapping',
            async () => {
                const f = await fixture();
                await Promise.all([
                    f.service.refresh({ refreshToken: f.raw }),
                    cleanup.handleTokenCleanup(),
                ]);
                await f.service.logout({ refreshToken: f.raw });
                assert.equal(await f.active(), 0);
            },
        );

        await t.test(
            'cleanup waits for a rotation that crosses the parent expiry boundary',
            async () => {
                const f = await fixture();
                const expiresAt = new Date(Date.now() + 1500);
                await prisma.refreshToken.update({
                    where: { id: f.rootToken.id },
                    data: { expiresAt },
                });
                let release!: () => void;
                let entered!: () => void;
                const signing = new Promise<void>((resolve) => {
                    entered = resolve;
                });
                const barrier = new Promise<void>((resolve) => {
                    release = resolve;
                });
                f.beforeSigning(() => {
                    entered();
                    return barrier;
                });
                const rotation = f.service.refresh({ refreshToken: f.raw });
                let cleaning: Promise<void> | undefined;
                try {
                    await signing;
                    await new Promise((resolve) =>
                        setTimeout(
                            resolve,
                            Math.max(0, expiresAt.getTime() - Date.now() + 50),
                        ),
                    );
                    cleaning = cleanup.handleTokenCleanup();
                    const deadline = Date.now() + 2000;
                    let waiting = false;
                    while (!waiting && Date.now() < deadline) {
                        const result = await sql.query<{ waiting: boolean }>(`
                            SELECT EXISTS (
                                SELECT 1 FROM pg_stat_activity
                                WHERE datname = current_database()
                                AND wait_event_type = 'Lock'
                                AND query LIKE '%SELECT u.id FROM users%'
                            ) AS waiting
                        `);
                        waiting = result.rows[0].waiting;
                        if (!waiting)
                            await new Promise((resolve) =>
                                setTimeout(resolve, 20),
                            );
                    }
                    assert.ok(
                        waiting,
                        'cleanup must wait on the rotation user lock',
                    );
                } finally {
                    release();
                    await rotation;
                    await cleaning;
                }
                assert.ok(
                    await prisma.refreshToken.findUnique({
                        where: { id: f.rootToken.id },
                    }),
                );
                await f.service.logout({ refreshToken: f.raw });
                assert.equal(await f.active(), 0);
            },
        );

        await t.test(
            'cleanup advances past a full batch of users',
            async () => {
                const users = Array.from({ length: 201 }, (_, index) => ({
                    id: `cleanup-batch-${String(index).padStart(3, '0')}`,
                    name: 'Cleanup batch fixture',
                    email: `cleanup-batch-${index}@example.invalid`,
                    password,
                }));
                await prisma.user.createMany({ data: users });
                await prisma.refreshToken.createMany({
                    data: users.map((user) => ({
                        userId: user.id,
                        token: hash(user.id),
                        expiresAt: new Date(0),
                    })),
                });
                await cleanup.handleTokenCleanup();
                assert.equal(
                    await prisma.refreshToken.count({
                        where: { userId: { in: users.map((user) => user.id) } },
                    }),
                    0,
                );
            },
        );

        await t.test(
            'fresh inactive and deleted users cannot rotate valid tokens',
            async () => {
                for (const state of ['inactive', 'deleted']) {
                    const f = await fixture();
                    await prisma.user.update({
                        where: { id: f.user.id },
                        data:
                            state === 'inactive'
                                ? { isActive: false }
                                : { deletedAt: new Date() },
                    });
                    await assert.rejects(
                        f.service.refresh({ refreshToken: f.raw }),
                    );
                    assert.equal(
                        await prisma.refreshToken.count({
                            where: { userId: f.user.id },
                        }),
                        1,
                    );
                }
            },
        );
    } finally {
        await db?.$disconnect();
        await sql.end();
    }
});
