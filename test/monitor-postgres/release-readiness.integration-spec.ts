import 'reflect-metadata';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { PrismaService } from '../../src/infra/database/prisma.service';
import { ProjectAccessService } from '../../src/common/authorization/project-access.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { NotificationAccessService } from '../../src/modules/notifications/notification-access.service';
import { MonitorCapacityService } from '../../src/shared/subscription/monitor-capacity.service';
import { EffectivePlanService } from '../../src/shared/subscription/effective-plan.service';
import { StateService } from '../../src/modules/state/state.service';
import { SchedulerHealthCollector } from '../../src/infra/scheduler/scheduler-health.collector';
import {
    assertEmptyDatabase,
    deployMigrations,
    root,
    validateTestUrl,
} from './harness';

void test('release readiness with real PostgreSQL transactions', async (t) => {
    const url = validateTestUrl(process.env.MONITOR_TEST_DATABASE_URL);
    const sql = new Client({
        connectionString: url,
        connectionTimeoutMillis: 5000,
        query_timeout: 5000,
    });
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
        const config = new ConfigService({
            app: { webUrl: 'https://example.invalid' },
        });
        const access = new ProjectAccessService(prisma);
        const notices = new NotificationsService(
            prisma,
            { kick() {} } as never,
            {} as never,
            new NotificationAccessService(prisma, access),
            access,
        );
        const capacity = new MonitorCapacityService(prisma, notices, config);
        const now = new Date();
        const day = 86_400_000;
        const free = await prisma.plan.create({
            data: { code: 'FREE', name: 'Free', maxMonitors: 1, sortOrder: 0 },
        });
        const basic = await prisma.plan.create({
            data: {
                code: 'BASIC',
                name: 'Basic',
                maxMonitors: 3,
                sortOrder: 1,
            },
        });
        const pro = await prisma.plan.create({
            data: { code: 'PRO', name: 'Pro', maxMonitors: 10, sortOrder: 2 },
        });
        const user = await prisma.user.create({
            data: {
                email: 'release@example.invalid',
                password: 'test-only',
                name: 'Fixture',
                emailVerified: true,
            },
        });
        let index = 0;
        async function workspace() {
            index++;
            const org = await prisma.organization.create({
                data: {
                    name: 'Fixture',
                    slug: `release-${index}`,
                    ownerId: user.id,
                    monitorCapacityPlanId: pro.id,
                    monitorCapacityLimit: 10,
                    monitorCapacityObservedAt: new Date(+now - day),
                },
            });
            await prisma.membership.create({
                data: {
                    userId: user.id,
                    organizationId: org.id,
                    role: 'OWNER',
                },
            });
            const project = await prisma.project.create({
                data: {
                    name: 'Fixture',
                    key: `REL${index}`,
                    organizationId: org.id,
                },
            });
            const expired = await prisma.subscription.create({
                data: {
                    organizationId: org.id,
                    planId: pro.id,
                    startsAt: new Date(+now - 30 * day),
                    expiresAt: now,
                    status: 'EXPIRED',
                },
            });
            return { org, project, expired };
        }

        await t.test(
            'capacity boundaries, idempotent durable email, restore and revision fencing',
            async () => {
                const { org, project } = await workspace();
                const monitors = [] as Awaited<
                    ReturnType<typeof prisma.monitor.create>
                >[];
                for (let i = 0; i < 3; i++)
                    monitors.push(
                        await prisma.monitor.create({
                            data: {
                                organizationId: org.id,
                                projectId: project.id,
                                name: `Monitor ${i}`,
                                type: 'HTTP',
                                target: 'https://example.invalid',
                                enabled: i < 2,
                                createdAt: new Date(+now - (3 - i) * 1000),
                            },
                        }),
                    );
                const reconcile = (plan: typeof free, at: Date) =>
                    prisma.$transaction(async (tx) => {
                        await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${org.id} FOR UPDATE`;
                        return capacity.reconcile(tx, org.id, plan, at);
                    });
                await Promise.all([reconcile(free, now), reconcile(free, now)]);
                const cycle =
                    await prisma.monitorCapacityCycle.findFirstOrThrow({
                        where: { organizationId: org.id },
                    });
                assert.equal(+cycle.graceEndsAt, +now + 3 * day);
                assert.equal(
                    await prisma.monitorCapacityCycle.count({
                        where: { organizationId: org.id },
                    }),
                    1,
                );
                const pending = await prisma.notificationDelivery.findMany({
                    where: { channel: 'EMAIL' },
                });
                assert.equal(pending.length, 1);
                await reconcile(free, new Date(+now + 3 * day - 1));
                await reconcile(free, new Date(+now + 3 * day));
                const limited =
                    await prisma.monitorCapacityCycle.findUniqueOrThrow({
                        where: { id: cycle.id },
                    });
                assert.equal(limited.status, 'LIMITED');
                assert.deepEqual(
                    limited.restrictedMonitorIds.sort(),
                    monitors
                        .slice(1)
                        .map((m) => m.id)
                        .sort(),
                );
                await reconcile(pro, new Date(+now + 3 * day));
                const restored = await prisma.monitor.findMany({
                    where: { organizationId: org.id },
                    orderBy: { createdAt: 'asc' },
                });
                assert.equal(restored[1].enabled, true);
                assert.equal(restored[2].enabled, false);
                assert.equal(restored[1].quotaGraceEndsAt, null);
                assert.ok(restored[1].revision > monitors[1].revision);
                const state = new StateService(prisma, {} as never, access);
                assert.equal(
                    await state.record(monitors[1].id, {
                        revision: monitors[1].revision,
                        configRevision: monitors[1].configRevision,
                        success: true,
                        latency: 1,
                    }),
                    null,
                );
                assert.equal(
                    await prisma.checkLog.count({
                        where: { monitorId: monitors[1].id },
                    }),
                    0,
                );
                const emails = await prisma.notificationDelivery.findMany({
                    where: { channel: 'EMAIL' },
                });
                assert.equal(
                    new Set(emails.map((row) => row.dedupKey)).size,
                    emails.length,
                );
                assert.ok(emails.length >= 3);
            },
        );

        await t.test(
            'an outbox failure rolls back the real capacity transaction',
            async () => {
                const { org, project } = await workspace();
                for (let i = 0; i < 2; i++)
                    await prisma.monitor.create({
                        data: {
                            organizationId: org.id,
                            projectId: project.id,
                            name: 'Rollback',
                            type: 'HTTP',
                            target: 'https://example.invalid',
                        },
                    });
                const before = await prisma.notificationDelivery.count();
                const failing = new MonitorCapacityService(
                    prisma,
                    {
                        organizationRecipients:
                            notices.organizationRecipients.bind(notices),
                        publish: async (
                            ...args: Parameters<typeof notices.publish>
                        ) => {
                            await notices.publish(...args);
                            throw new Error('injected post-outbox failure');
                        },
                    } as never,
                    config,
                );
                await assert.rejects(
                    prisma.$transaction(async (tx) => {
                        await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${org.id} FOR UPDATE`;
                        await failing.reconcile(tx, org.id, free, now);
                    }),
                    /injected post-outbox failure/,
                );
                assert.equal(await prisma.notificationDelivery.count(), before);
                assert.equal(
                    await prisma.monitorCapacityCycle.count({
                        where: { organizationId: org.id },
                    }),
                    0,
                );
                assert.equal(
                    (
                        await prisma.organization.findUniqueOrThrow({
                            where: { id: org.id },
                        })
                    ).monitorCapacityPlanId,
                    pro.id,
                );
                assert.equal(
                    await prisma.monitor.count({
                        where: {
                            organizationId: org.id,
                            quotaGraceEndsAt: { not: null },
                        },
                    }),
                    0,
                );
            },
        );

        await t.test(
            'concurrent effective-plan reads resume frozen days exactly once',
            async () => {
                const { org } = await workspace();
                const paused = await prisma.subscription.create({
                    data: {
                        organizationId: org.id,
                        planId: basic.id,
                        status: 'PAUSED',
                        startsAt: new Date(+now - 20 * day),
                        expiresAt: new Date(+now - day),
                        pausedAt: new Date(+now - 10 * day),
                        pausedRemainingDays: 5,
                    },
                });
                const plans = new EffectivePlanService(prisma, capacity);
                const results = await Promise.all([
                    plans.getEffectivePlan(org.id),
                    plans.getEffectivePlan(org.id),
                ]);
                assert.ok(results.every((p) => p?.id === basic.id));
                const current = await prisma.subscription.findUniqueOrThrow({
                    where: { id: paused.id },
                });
                assert.equal(current.status, 'ACTIVE');
                assert.equal(current.pausedRemainingDays, null);
                assert.equal(+current.expiresAt - +current.startsAt, 5 * day);
                assert.equal(
                    await prisma.subscription.count({
                        where: { organizationId: org.id, status: 'ACTIVE' },
                    }),
                    1,
                );
            },
        );

        await t.test(
            'backlog collection executes real SQL and excludes manual pauses',
            async () => {
                const samples = new Map<
                    string,
                    { count: number; age: number }
                >();
                const failures: string[] = [];
                const metrics = {
                    setQueueSnapshot() {},
                    recordSnapshot(source: string, success: boolean) {
                        if (!success) failures.push(source);
                    },
                    setWorkBacklog(source: string, count: number, age: number) {
                        samples.set(source, { count, age });
                    },
                };
                const queue = {
                    getJobCounts: () => Promise.resolve({ waiting: 0 }),
                } as never;
                await new SchedulerHealthCollector(
                    prisma,
                    metrics as never,
                    queue,
                    queue,
                    queue,
                    queue,
                ).collect();
                assert.deepEqual(failures, []);
                assert.equal(samples.get('monitor-checks')?.count, 4);
                assert.ok(samples.has('alert-deliveries'));
                assert.ok(samples.has('workspace-notifications'));
            },
        );
    } finally {
        await db?.$disconnect();
        await sql.end();
    }
});
