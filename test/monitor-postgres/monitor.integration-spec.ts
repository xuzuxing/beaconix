import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { PrismaService } from '../../src/infra/database/prisma.service';
import { MonitorStatus, MonitorType } from '../../src/generated/prisma/enums';
import { StateService } from '../../src/modules/state/state.service';
import { CheckerService } from '../../src/modules/checker/checker.service';
import { AlertEventsService } from '../../src/modules/alert-events/alert-events.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { NotificationAccessService } from '../../src/modules/notifications/notification-access.service';
import type { CheckMetadata } from '../../src/modules/checker/checkers/check-result';
import { ProjectAccessService } from '../../src/common/authorization/project-access.service';
import { systemPrincipal } from '../../src/common/authorization/access.types';
import {
    addLocalMigrations,
    addProbeSuccessRatioMigration,
    assertEmptyDatabase,
    deployMigrations,
    localMigrations,
    removeStagedMigrations,
    stageMigrations,
    validateTestUrl,
    probeSuccessRatioMigrations,
} from './harness';

type Table =
    'monitors' | 'monitor_states' | 'check_logs' | 'plans' | 'subscriptions';
type Row = Record<string, unknown>;

async function snapshot(client: Client, table: Table): Promise<Row[]> {
    const key = table === 'monitor_states' ? 'monitorId' : 'id';
    const result = await client.query<{ row: Row }>(
        `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY "${key}"`,
    );
    return result.rows.map(({ row }) => row);
}

function without(rows: Row[], fields: string[]): Row[] {
    return rows.map((row) =>
        Object.fromEntries(
            Object.entries(row).filter(([key]) => !fields.includes(key)),
        ),
    );
}

void test('local monitor migrations and real PostgreSQL state transactions', async (t) => {
    const url = validateTestUrl(process.env.MONITOR_TEST_DATABASE_URL);
    const sql = new Client({
        connectionString: url,
        connectionTimeoutMillis: 5000,
        query_timeout: 5000,
    });
    let migrations: string | undefined;
    let prisma: PrismaService | undefined;
    try {
        await sql.connect();
        await assertEmptyDatabase(sql);
        migrations = await stageMigrations();
        await deployMigrations(url, migrations);
        await sql.query(
            await readFile(join(__dirname, 'legacy-fixtures.sql'), 'utf8'),
        );
        const before = {
            monitors: await snapshot(sql, 'monitors'),
            states: await snapshot(sql, 'monitor_states'),
            logs: await snapshot(sql, 'check_logs'),
            plans: await snapshot(sql, 'plans'),
            subscriptions: await snapshot(sql, 'subscriptions'),
        };
        await addLocalMigrations(migrations);
        await deployMigrations(url, migrations);

        await t.test(
            'preserves every existing field and backfills defaults',
            async () => {
                const monitors = await snapshot(sql, 'monitors');
                assert.deepEqual(
                    without(monitors, [
                        'config',
                        'configVersion',
                        'revision',
                        'credentialsEnc',
                    ]),
                    before.monitors,
                );
                for (const monitor of monitors) {
                    assert.deepEqual(monitor.config, {});
                    assert.equal(monitor.configVersion, 1);
                    assert.equal(monitor.revision, 1);
                    assert.equal(monitor.credentialsEnc, null);
                }
                const states = await snapshot(sql, 'monitor_states');
                assert.deepEqual(
                    without(states, [
                        'executionBlockedReason',
                        'availabilityAlertPendingId',
                    ]),
                    before.states,
                );
                for (const state of states) {
                    assert.equal(state.executionBlockedReason, null);
                    assert.equal(state.availabilityAlertPendingId, null);
                }
                const logs = await snapshot(sql, 'check_logs');
                assert.deepEqual(
                    without(logs, [
                        'revision',
                        'evaluated',
                        'failureKind',
                        'meta',
                    ]),
                    before.logs,
                );
                for (const log of logs) {
                    assert.equal(log.revision, 1);
                    assert.equal(log.evaluated, true);
                    assert.equal(log.failureKind, null);
                    assert.deepEqual(log.meta, {});
                }
                const plans = await snapshot(sql, 'plans');
                assert.deepEqual(
                    without(plans, ['allowedMonitorTypes']),
                    before.plans,
                );
                for (const plan of plans) {
                    assert.deepEqual(
                        [...(plan.allowedMonitorTypes as string[])].sort(),
                        ['PRO', 'TEAM'].includes(String(plan.code))
                            ? Object.values(MonitorType).sort()
                            : ['HTTP', 'TCP', 'PING'].sort(),
                    );
                }
                assert.deepEqual(
                    await snapshot(sql, 'subscriptions'),
                    before.subscriptions,
                );
            },
        );

        await t.test(
            'migrate deploy can be repeated without replaying migrations',
            async () => {
                const applied = await sql.query(
                    'SELECT id, migration_name, finished_at FROM "_prisma_migrations" ORDER BY migration_name',
                );
                for (const name of localMigrations) {
                    assert.ok(
                        applied.rows.some(
                            (row) =>
                                row.migration_name === name && row.finished_at,
                        ),
                    );
                }
                await deployMigrations(url, migrations!);
                assert.deepEqual(
                    (
                        await sql.query(
                            'SELECT id, migration_name, finished_at FROM "_prisma_migrations" ORDER BY migration_name',
                        )
                    ).rows,
                    applied.rows,
                );
                await assert.rejects(assertEmptyDatabase(sql), /nonempty/);
            },
        );

        await t.test(
            'upgrades the running system to the probe ratio schema',
            async () => {
                const before = {
                    monitors: await snapshot(sql, 'monitors'),
                    states: await snapshot(sql, 'monitor_states'),
                    logs: await snapshot(sql, 'check_logs'),
                    plans: await snapshot(sql, 'plans'),
                    subscriptions: await snapshot(sql, 'subscriptions'),
                };
                const revisions = (
                    await sql.query(
                        'SELECT id, "configRevision" FROM monitors ORDER BY id',
                    )
                ).rows;
                await addProbeSuccessRatioMigration(migrations!);
                await deployMigrations(url, migrations!);

                const monitors = await snapshot(sql, 'monitors');
                assert.deepEqual(
                    without(monitors, ['probeSuccessRatio']),
                    before.monitors,
                );
                for (const monitor of monitors) {
                    assert.equal(monitor.probeSuccessRatio, 1);
                }
                const logs = await snapshot(sql, 'check_logs');
                assert.deepEqual(
                    without(logs, ['roundId', 'appliedAt']),
                    before.logs,
                );
                for (const log of logs) {
                    assert.equal(log.roundId, null);
                    assert.equal(log.appliedAt, null);
                }
                assert.deepEqual(
                    await snapshot(sql, 'monitor_states'),
                    before.states,
                );
                assert.deepEqual(await snapshot(sql, 'plans'), before.plans);
                assert.deepEqual(
                    await snapshot(sql, 'subscriptions'),
                    before.subscriptions,
                );
                // Adding a configuration column must not advance a version by
                // itself; only a real edit does.
                assert.deepEqual(
                    (
                        await sql.query(
                            'SELECT id, "configRevision" FROM monitors ORDER BY id',
                        )
                    ).rows,
                    revisions,
                );

                const applied = (
                    await sql.query(
                        'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
                    )
                ).rows.map((row) => row.migration_name);
                for (const name of probeSuccessRatioMigrations) {
                    assert.ok(applied.includes(name));
                }
                await deployMigrations(url, migrations!);
            },
        );

        prisma = new PrismaService(
            new ConfigService({
                database: { url },
                app: { isDevelopment: false },
            }),
        );
        await prisma.$connect();
        const db = prisma;
        const access = new ProjectAccessService(db);
        const notifications = new NotificationsService(
            db,
            { kick: () => undefined } as never,
            { getStream: () => undefined } as never,
            new NotificationAccessService(db, access),
            access,
        );
        await db.membership.create({
            data: {
                userId: 'fixture-user',
                organizationId: 'fixture-org',
                role: 'ADMIN',
            },
        });
        const state = new StateService(
            db,
            new AlertEventsService(db, notifications, access),
            access,
        );
        const createMonitor = (type: MonitorType = MonitorType.HTTP) =>
            db.monitor.create({
                data: {
                    organizationId: 'fixture-org',
                    projectId: 'fixture-project',
                    name: 'Transaction fixture',
                    type,
                    target:
                        type === MonitorType.PING
                            ? '1.1.1.1'
                            : 'example.invalid',
                    failureThreshold: 2,
                },
            });

        await t.test(
            'real monitor transitions persist station notices and delivery intents',
            async () => {
                const monitor = await createMonitor();
                await state.record(monitor.id, { success: true, latency: 10 });
                await state.record(monitor.id, { success: false, latency: 10 });
                await state.record(monitor.id, { success: false, latency: 10 });
                await state.record(monitor.id, { success: false, latency: 10 });
                const openings = await db.notification.findMany({
                    where: {
                        resourceType: 'Monitor',
                        resourceId: monitor.id,
                        type: 'MONITOR_ALERT',
                    },
                });
                assert.equal(openings.length, 1);
                assert.equal(openings[0].userId, 'fixture-user');
                await state.record(monitor.id, { success: true, latency: 10 });
                const recoveries = await db.notification.findMany({
                    where: {
                        resourceType: 'Monitor',
                        resourceId: monitor.id,
                        type: 'MONITOR_RECOVERED',
                    },
                });
                assert.equal(recoveries.length, 1);
                assert.equal(recoveries[0].userId, 'fixture-user');
                for (const notice of [...openings, ...recoveries]) {
                    assert.equal(
                        await db.notificationDelivery.count({
                            where: {
                                channel: 'SSE',
                                payload: {
                                    path: ['notificationId'],
                                    equals: notice.id,
                                },
                            },
                        }),
                        1,
                    );
                }
            },
        );

        await t.test(
            'protocol configuration changes invalidate versioned probe observations',
            async () => {
                const monitor = await createMonitor();
                const updated = await db.monitor.update({
                    where: { id: monitor.id },
                    data: {
                        config: { keyword: 'ready' },
                        revision: { increment: 1 },
                    },
                });
                assert.equal(
                    updated.configRevision,
                    monitor.configRevision + 1,
                );
                assert.equal(
                    await state.record(monitor.id, {
                        revision: monitor.revision,
                        configRevision: monitor.configRevision,
                        success: false,
                        latency: 10,
                    }),
                    null,
                );
                assert.equal(
                    await db.checkLog.count({
                        where: { monitorId: monitor.id },
                    }),
                    0,
                );
            },
        );

        await t.test(
            'all application enum values and encrypted credential storage round-trip',
            async () => {
                const types = Object.values(MonitorType).filter(
                    (type) => !['HTTP', 'TCP', 'PING', 'DNS'].includes(type),
                );
                for (const type of types) {
                    const monitor = await createMonitor(type);
                    assert.equal(monitor.type, type);
                    assert.equal(monitor.credentialsEnc, null);
                    const saved = await db.monitor.update({
                        where: { id: monitor.id },
                        data: {
                            credentialsEnc:
                                'encrypted-fixture-not-a-real-secret',
                        },
                    });
                    assert.equal(
                        saved.credentialsEnc,
                        'encrypted-fixture-not-a-real-secret',
                    );
                }
            },
        );

        await t.test(
            'new enum values and JSON metadata round-trip through Prisma',
            async () => {
                for (const type of [MonitorType.DNS, MonitorType.PING]) {
                    const monitor = await createMonitor(type);
                    assert.deepEqual(monitor.config, {});
                    assert.equal(monitor.revision, 1);
                    assert.equal(monitor.configVersion, 1);
                    const meta: CheckMetadata =
                        type === MonitorType.DNS
                            ? {
                                  protocol: 'DNS',
                                  recordType: 'A',
                                  actualValues: ['1.1.1.1'],
                                  ttl: [60],
                              }
                            : {
                                  protocol: 'PING',
                                  sent: 3,
                                  received: 3,
                                  packetLoss: 0,
                              };
                    await state.record(monitor.id, {
                        revision: 1,
                        success: true,
                        latency: 12,
                        meta,
                    });
                    const log = await db.checkLog.findFirstOrThrow({
                        where: { monitorId: monitor.id },
                    });
                    assert.deepEqual(log.meta, meta);
                    assert.equal(log.evaluated, true);
                }
                const plan = await db.plan.create({
                    data: { code: 'NEW_CUSTOM', name: 'New custom' },
                });
                assert.deepEqual(plan.allowedMonitorTypes, [
                    'HTTP',
                    'TCP',
                    'PING',
                ]);
            },
        );

        await t.test(
            'concurrent folds do not lose failure increments',
            async () => {
                const monitor = await createMonitor();
                const outcome = {
                    revision: 1,
                    success: false,
                    latency: 10,
                    checkedAt: new Date(),
                };
                const results = await Promise.all([
                    state.record(monitor.id, outcome),
                    state.record(monitor.id, outcome),
                ]);
                assert.ok(results.every(Boolean));
                const current = await db.monitorState.findUniqueOrThrow({
                    where: { monitorId: monitor.id },
                });
                assert.equal(current.failCount, 2);
                assert.equal(current.status, MonitorStatus.DOWN);
                assert.equal(
                    await db.checkLog.count({
                        where: { monitorId: monitor.id },
                    }),
                    2,
                );
            },
        );

        await t.test(
            'bounds the probe success ratio and versions real edits',
            async () => {
                const monitor = await createMonitor();
                assert.equal(monitor.probeSuccessRatio, 1);

                const updated = await db.monitor.update({
                    where: { id: monitor.id },
                    data: { probeSuccessRatio: 60 },
                });
                assert.equal(updated.probeSuccessRatio, 60);
                assert.equal(
                    updated.configRevision,
                    monitor.configRevision + 1,
                );

                const sameValue = await db.monitor.update({
                    where: { id: monitor.id },
                    data: { probeSuccessRatio: 60 },
                });
                assert.equal(sameValue.configRevision, updated.configRevision);

                for (const invalid of [0, 101]) {
                    await assert.rejects(
                        db.monitor.update({
                            where: { id: monitor.id },
                            data: { probeSuccessRatio: invalid },
                        }),
                    );
                }

                // Evidence captured before the edit can no longer be applied.
                assert.equal(
                    await state.record(monitor.id, {
                        revision: monitor.revision,
                        configRevision: monitor.configRevision,
                        success: false,
                        latency: 10,
                    }),
                    null,
                );
            },
        );

        await t.test(
            'settles a batch once and keeps legacy null rounds unconstrained',
            async () => {
                const monitor = await createMonitor();
                const roundId = `${monitor.id}:1700000000000`;
                const pending = {
                    monitorId: monitor.id,
                    monitorRefId: monitor.id,
                    organizationId: 'fixture-org',
                    projectId: 'fixture-project',
                    monitorType: monitor.type,
                    success: true,
                    localSuccess: true,
                    latency: 10,
                    configRevision: monitor.configRevision,
                    revision: monitor.revision,
                    roundId,
                };
                await db.checkLog.create({ data: pending });
                // Legacy rows (no round) may repeat freely.
                await db.checkLog.create({
                    data: { ...pending, roundId: null },
                });
                await db.checkLog.create({
                    data: { ...pending, roundId: null },
                });
                await assert.rejects(db.checkLog.create({ data: pending }));

                const verdict = {
                    roundId,
                    success: true,
                    error: null,
                    latency: 10,
                    statusCode: 200,
                    localSuccess: true,
                    rescuedByProbe: false,
                    failureKind: null,
                    serviceVerdict: 'SUCCESS' as const,
                    localServiceVerdict: 'SUCCESS' as const,
                    ruleMatched: false,
                    ruleGroupIds: [],
                    aggregation: {
                        protected: false,
                        protectedReason: null,
                        effectiveProbeCount: 1,
                        expectedProbeCount: 1,
                        tenantProbeCount: 1,
                        systemProbeCount: 0,
                        sampleCount: 1,
                        successCount: 1,
                        ratio: 100,
                        threshold: 100,
                        decision: 'CONFIRMED_SUCCESS' as const,
                        settledAt: new Date().toISOString(),
                    },
                    configRevision: monitor.configRevision,
                    revision: monitor.revision,
                };
                assert.ok(await state.settle(monitor.id, roundId, verdict));
                assert.equal(
                    await state.settle(monitor.id, roundId, verdict),
                    null,
                );
                const current = await db.monitorState.findUniqueOrThrow({
                    where: { monitorId: monitor.id },
                });
                assert.equal(current.failCount, 0);
                assert.equal(
                    await db.checkLog.count({
                        where: { monitorId: monitor.id, roundId },
                    }),
                    1,
                );
                assert.equal(
                    (
                        await db.checkLog.findFirstOrThrow({
                            where: { monitorId: monitor.id, roundId },
                        })
                    ).appliedAt instanceof Date,
                    true,
                );
            },
        );

        await t.test(
            'primary probe votes are scoped to one monitor, revision and batch',
            async () => {
                const checker = new CheckerService(
                    db,
                    state,
                    {} as never,
                    {
                        check: () => ({
                            success: true,
                            latency: 1,
                            error: null,
                            checkedAt: new Date(),
                        }),
                    } as never,
                    {
                        monitorEligibility: () => ({
                            eligible: true,
                            reason: null,
                        }),
                    } as never,
                    { getAssignedProbes: () => [] } as never,
                    { evaluate: () => false, explain: () => [] } as never,
                    { findBindingsForMonitor: () => [] } as never,
                    access,
                );

                const monitor = await db.monitor.create({
                    data: {
                        organizationId: 'fixture-org',
                        projectId: 'fixture-project',
                        name: 'Ratio fixture',
                        type: MonitorType.HTTP,
                        target: 'https://ratio.example.invalid/health',
                        probeSuccessRatio: 100,
                        failureThreshold: 3,
                    },
                });
                const createProbe = (name: string) =>
                    db.probe.create({
                        data: {
                            organizationId: 'fixture-org',
                            scope: 'TENANT',
                            name,
                            provider: 'CUSTOM',
                            region: 'test',
                            callbackUrl: 'https://probe.example.invalid',
                            status: 'ONLINE',
                        },
                    });
                const [first, second, third] = await Promise.all([
                    createProbe('probe-1'),
                    createProbe('probe-2'),
                    createProbe('probe-3'),
                ]);
                for (const probe of [first, second, third]) {
                    await db.monitorProbe.create({
                        data: { monitorId: monitor.id, probeId: probe.id },
                    });
                }

                const now = Date.now();
                const previousRound = `${monitor.id}:${now - 120_000}`;
                const roundId = `${monitor.id}:${now}`;
                const createRound = (
                    id: string,
                    checkedAt: Date,
                    appliedAt: Date | null,
                ) =>
                    db.checkLog.create({
                        data: {
                            monitorId: monitor.id,
                            monitorRefId: monitor.id,
                            organizationId: 'fixture-org',
                            projectId: 'fixture-project',
                            monitorType: monitor.type,
                            success: true,
                            localSuccess: true,
                            latency: 10,
                            source: 'LOCAL',
                            checkedAt,
                            roundId: id,
                            appliedAt,
                            configRevision: monitor.configRevision,
                            revision: monitor.revision,
                        },
                    });
                await createRound(
                    previousRound,
                    new Date(now - 120_000),
                    new Date(now - 60_000),
                );
                await createRound(roundId, new Date(now), null);

                const sample = (
                    probeId: string,
                    success: boolean,
                    targetRound: string | null,
                    configRevision = monitor.configRevision,
                    checkedAt = new Date(now - 30_000),
                ) =>
                    db.probeResult.create({
                        data: {
                            probeId,
                            probeRefId: probeId,
                            monitorId: monitor.id,
                            projectId: 'fixture-project',
                            organizationId: 'fixture-org',
                            monitorType: monitor.type,
                            target: monitor.target,
                            configRevision,
                            roundId: targetRound,
                            checkedAt,
                            receivedAt: checkedAt,
                            success,
                            latency: 10,
                        },
                    });
                await sample(first.id, true, roundId);
                await sample(second.id, true, roundId);
                // The third probe reported a failure in the previous batch: the
                // previous round still counts, so this is its vote.
                await sample(third.id, false, previousRound);

                // Noise that must never take part in this monitor's vote.
                const other = await db.monitor.create({
                    data: {
                        organizationId: 'fixture-org',
                        projectId: 'fixture-project',
                        name: 'Same target',
                        type: MonitorType.HTTP,
                        target: monitor.target,
                    },
                });
                await db.probeResult.create({
                    data: {
                        probeId: first.id,
                        probeRefId: first.id,
                        monitorId: other.id,
                        projectId: 'fixture-project',
                        organizationId: 'fixture-org',
                        target: monitor.target,
                        configRevision: other.configRevision,
                        roundId,
                        checkedAt: new Date(now - 10_000),
                        receivedAt: new Date(now - 10_000),
                        success: true,
                        latency: 10,
                    },
                });
                // A stale revision and another organization's probe are ignored.
                await sample(
                    second.id,
                    true,
                    roundId,
                    monitor.configRevision - 1,
                );
                const foreign = await db.probe.create({
                    data: {
                        organizationId: null,
                        scope: 'SYSTEM',
                        name: 'system-probe',
                        provider: 'CUSTOM',
                        region: 'test',
                        callbackUrl: 'https://probe.example.invalid',
                        status: 'ONLINE',
                    },
                });
                await db.monitorProbe.create({
                    data: { monitorId: monitor.id, probeId: foreign.id },
                });
                await sample(foreign.id, true, roundId);

                const settled = await checker.settleRound(monitor.id, roundId, {
                    force: true,
                });
                assert.equal(settled.outcome, 'SETTLED');
                const row = await db.checkLog.findFirstOrThrow({
                    where: { monitorId: monitor.id, roundId },
                });
                // 2 of 3 tenant probes succeeded: below 100%.
                assert.equal(row.success, false);
                assert.equal(row.failureKind, 'AGGREGATE');
                assert.equal(row.localSuccess, true);
                const aggregation = (
                    row.meta as {
                        aggregation: {
                            effectiveProbeCount: number;
                            sampleCount: number;
                            successCount: number;
                        };
                    }
                ).aggregation;
                assert.equal(aggregation.effectiveProbeCount, 3);
                assert.equal(aggregation.sampleCount, 3);
                assert.equal(aggregation.successCount, 2);
                const failed = await db.monitorState.findUniqueOrThrow({
                    where: { monitorId: monitor.id },
                });
                assert.equal(failed.failCount, 1);

                // A second settlement of the same batch changes nothing.
                assert.equal(
                    (
                        await checker.settleRound(monitor.id, roundId, {
                            force: true,
                        })
                    ).outcome,
                    'DUPLICATE',
                );
                assert.equal(
                    (
                        await db.monitorState.findUniqueOrThrow({
                            where: { monitorId: monitor.id },
                        })
                    ).failCount,
                    1,
                );

                // Unbinding the failing probe removes it from both sides.
                await db.monitorProbe.delete({
                    where: {
                        monitorId_probeId: {
                            monitorId: monitor.id,
                            probeId: third.id,
                        },
                    },
                });
                const nextRound = `${monitor.id}:${now + 60_000}`;
                await createRound(nextRound, new Date(now + 60_000), null);
                await sample(
                    first.id,
                    true,
                    nextRound,
                    undefined,
                    new Date(now + 30_000),
                );
                await sample(
                    second.id,
                    true,
                    nextRound,
                    undefined,
                    new Date(now + 30_000),
                );
                const next = await checker.settleRound(monitor.id, nextRound, {
                    force: true,
                });
                assert.equal(next.outcome, 'SETTLED');
                const recovered = await db.monitorState.findUniqueOrThrow({
                    where: { monitorId: monitor.id },
                });
                assert.equal(recovered.failCount, 0);
                assert.equal(recovered.status, MonitorStatus.UP);
            },
        );

        await t.test(
            'paused, deleted and superseded definitions reject results',
            async () => {
                for (const update of [
                    { enabled: false },
                    { deletedAt: new Date() },
                    { revision: 2 },
                ]) {
                    const monitor = await createMonitor();
                    await db.monitor.update({
                        where: { id: monitor.id },
                        data: update,
                    });
                    assert.equal(
                        await state.record(monitor.id, {
                            revision: 1,
                            success: false,
                            latency: 10,
                        }),
                        null,
                    );
                    assert.equal(
                        await db.checkLog.count({
                            where: { monitorId: monitor.id },
                        }),
                        0,
                    );
                }
            },
        );

        await t.test(
            'definition edit commits before a blocked old result is folded',
            async () => {
                const monitor = await createMonitor();
                let pending:
                    | Promise<{ result: unknown } | { error: unknown }>
                    | undefined;
                await sql.query('BEGIN');
                try {
                    await sql.query(
                        'SELECT id FROM monitors WHERE id = $1 FOR UPDATE',
                        [monitor.id],
                    );
                    pending = state
                        .record(monitor.id, {
                            revision: 1,
                            success: false,
                            latency: 10,
                        })
                        .then(
                            (result) => ({ result }),
                            (error: unknown) => ({ error }),
                        );
                    // Observe the actual lock wait, rather than relying on sleep ordering.
                    let waiting = false;
                    const deadline = Date.now() + 3000;
                    while (Date.now() < deadline) {
                        // Statistics snapshots otherwise remain cached in this transaction.
                        await sql.query('SELECT pg_stat_clear_snapshot()');
                        const locks = await sql.query(`
                        SELECT 1 FROM pg_stat_activity
                        WHERE datname = current_database()
                        AND pid <> pg_backend_pid()
                        AND wait_event_type = 'Lock'
                        -- Prisma's $queryRaw sends the template verbatim, so the
                        -- identifier is unquoted here: no FROM "monitors" match.
                        AND query LIKE '%FROM monitors%FOR UPDATE%'
                    `);
                        if (locks.rows.length) {
                            waiting = true;
                            break;
                        }
                        await delay(20);
                    }
                    assert.ok(
                        waiting,
                        'StateService must wait for the Monitor row lock',
                    );
                    await sql.query(
                        'UPDATE monitors SET revision = revision + 1 WHERE id = $1',
                        [monitor.id],
                    );
                    await sql.query('COMMIT');
                    assert.deepEqual(await pending, { result: null });
                    assert.equal(
                        await db.checkLog.count({
                            where: { monitorId: monitor.id },
                        }),
                        0,
                    );
                    assert.equal(
                        await db.monitorState.count({
                            where: { monitorId: monitor.id },
                        }),
                        0,
                    );
                } finally {
                    await sql.query('ROLLBACK');
                    await pending;
                }
            },
        );

        await t.test(
            'blocked and out-of-order results cannot corrupt status or uptime',
            async () => {
                const monitor = await createMonitor();
                const checkedAt = new Date();
                await state.record(monitor.id, {
                    revision: 1,
                    success: true,
                    latency: 20,
                    checkedAt,
                });
                assert.equal(
                    await state.record(monitor.id, {
                        revision: 1,
                        success: false,
                        latency: 10,
                        checkedAt: new Date(checkedAt.getTime() - 1),
                    }),
                    null,
                );
                const recorded = await state.record(monitor.id, {
                    revision: 1,
                    success: false,
                    evaluated: false,
                    failureKind: 'CAPABILITY',
                    error: 'Fixture capability unavailable',
                    latency: 5000,
                    checkedAt: new Date(checkedAt.getTime() + 1),
                });
                assert.equal(recorded?.state.status, MonitorStatus.UP);
                assert.equal(recorded?.state.failCount, 0);
                assert.equal(
                    recorded?.state.lastCheckAt?.getTime(),
                    checkedAt.getTime(),
                );
                const summary = await state.getSummary(
                    'fixture-project',
                    monitor.id,
                    systemPrincipal('monitor integration state fixture'),
                );
                assert.equal(summary.uptimePercent, 100);
                assert.equal(summary.avgLatency, 20);
                assert.equal(
                    await db.checkLog.count({
                        where: { monitorId: monitor.id },
                    }),
                    2,
                );
            },
        );

        await t.test(
            'pending alerts survive re-instantiation and stale ACKs',
            async () => {
                const monitor = await createMonitor();
                const first = await state.record(monitor.id, {
                    revision: 1,
                    success: false,
                    latency: 10,
                });
                const token = await state.claimAvailabilityAlert(
                    monitor.id,
                    1,
                    true,
                    first!.state.lastCheckAt,
                );
                assert.ok(token);
                const restarted = new StateService(
                    db,
                    new AlertEventsService(db, notifications, access),
                    access,
                );
                assert.equal(
                    await restarted.claimAvailabilityAlert(
                        monitor.id,
                        1,
                        true,
                        first!.state.lastCheckAt,
                    ),
                    token,
                );
                await restarted.completeAvailabilityAlert(
                    monitor.id,
                    1,
                    true,
                    'stale-token',
                );
                await restarted.completeAvailabilityAlert(
                    monitor.id,
                    2,
                    true,
                    token,
                );
                assert.equal(
                    (
                        await db.monitorState.findUniqueOrThrow({
                            where: { monitorId: monitor.id },
                        })
                    ).availabilityAlertPendingId,
                    token,
                );
                await restarted.completeAvailabilityAlert(
                    monitor.id,
                    1,
                    true,
                    token,
                );
                assert.equal(
                    (
                        await db.monitorState.findUniqueOrThrow({
                            where: { monitorId: monitor.id },
                        })
                    ).availabilityAlertPendingId,
                    null,
                );
            },
        );
    } finally {
        await prisma?.$disconnect();
        await sql.end();
        if (migrations) await removeStagedMigrations(migrations);
    }
});
