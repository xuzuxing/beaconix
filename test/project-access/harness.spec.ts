import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { QueryResultRow } from 'pg';
import {
    PROJECT_ACCESS_DATABASES,
    validateProjectAccessDatabase,
    type ProjectAccessDatabaseKind,
    type ValidatedProjectAccessDatabase,
} from './database-safety';
import {
    aclMigration,
    addMigrations,
    compatibilityMigrations,
    connectPrisma,
    deployMigrations,
    disconnectedPrisma,
    explicitConnectionString,
    HarnessFailure,
    openProjectAccessDatabases,
    removeStagedMigrations,
    root,
    safeAcceptance,
    stageLegacyMigrations,
    type SqlDatabase,
} from './harness';

const kinds = ['fresh', 'upgrade', 'http'] as const;
const environment = Object.fromEntries(
    kinds.map((kind) => [
        PROJECT_ACCESS_DATABASES[kind].variable,
        `postgresql://fixture:secret@localhost/${PROJECT_ACCESS_DATABASES[kind].prefix}_offline`,
    ]),
);

function fakeConnector(
    options: {
        nonempty?: ProjectAccessDatabaseKind;
        wrongIdentity?: ProjectAccessDatabaseKind;
        queryFailure?: ProjectAccessDatabaseKind;
        connectionFailure?: ProjectAccessDatabaseKind;
    } = {},
) {
    const events: string[] = [];
    const databases: ValidatedProjectAccessDatabase[] = [];
    return {
        events,
        databases,
        connect(
            this: void,
            database: ValidatedProjectAccessDatabase,
        ): Promise<SqlDatabase> {
            events.push(`${database.kind}:connect`);
            databases.push(database);
            if (database.kind === options.connectionFailure) {
                return Promise.reject(
                    new Error('postgresql://fixture:secret@localhost/private'),
                );
            }
            return Promise.resolve({
                database,
                query<T extends QueryResultRow>(sql: string) {
                    assert.ok(sql.trim().startsWith('SELECT'));
                    const identity = sql.includes('current_database()');
                    events.push(
                        `${database.kind}:${identity ? 'identity' : 'catalog'}`,
                    );
                    if (database.kind === options.queryFailure) {
                        return Promise.reject(
                            new Error(
                                'driver leaked postgresql://fixture:secret@localhost/private',
                            ),
                        );
                    }
                    const rows = identity
                        ? [
                              {
                                  database:
                                      database.kind === options.wrongIdentity
                                          ? 'private'
                                          : database.database,
                              },
                          ]
                        : database.kind === options.nonempty
                          ? [{ occupied: 1 }]
                          : [];
                    return Promise.resolve({
                        rows: rows as unknown as T[],
                        rowCount: rows.length,
                    });
                },
                close() {
                    events.push(`${database.kind}:close`);
                    return Promise.resolve();
                },
            });
        },
    };
}

for (const kind of kinds) {
    void test(`missing ${kind} URL refuses before any connection, including HTTP-only runs`, async () => {
        const connector = fakeConnector();
        const env = {
            ...environment,
            DATABASE_URL: environment[PROJECT_ACCESS_DATABASES[kind].variable],
        };
        delete env[PROJECT_ACCESS_DATABASES[kind].variable];
        await assert.rejects(
            openProjectAccessDatabases(['http'], env, connector.connect),
        );
        assert.deepEqual(connector.events, []);
    });
}

void test('unsafe credentials-bearing URL is refused without driver invocation or raw diagnostics', async () => {
    const connector = fakeConnector();
    const env = {
        ...environment,
        PROJECT_ACCESS_HTTP_TEST_DATABASE_URL:
            'postgresql://secret:password@remote/private',
    };
    await assert.rejects(
        openProjectAccessDatabases(kinds, env, connector.connect),
        (error: Error) => {
            assert.ok(!error.message.includes('password'));
            assert.ok(!error.message.includes('remote'));
            return true;
        },
    );
    assert.deepEqual(connector.events, []);
});

void test('all identities and empty catalogs precede successful migration capability', async () => {
    const connector = fakeConnector();
    const handle = await openProjectAccessDatabases(
        kinds,
        environment,
        connector.connect,
    );
    try {
        assert.deepEqual(connector.events, [
            'fresh:connect',
            'upgrade:connect',
            'http:connect',
            'fresh:identity',
            'fresh:catalog',
            'upgrade:identity',
            'upgrade:catalog',
            'http:identity',
            'http:catalog',
        ]);
        assert.equal(handle.get('fresh').database, connector.databases[0]);
        assert.ok(connector.databases.every(Object.isFrozen));
        await assert.rejects(
            deployMigrations(handle.get('fresh').database, root),
            /unowned migration directory/,
        );
    } finally {
        await handle.close();
    }
    await assert.rejects(connectPrisma(connector.databases[0]), /preflight/);
    assert.equal(
        connector.events.filter((event) => event.endsWith(':close')).length,
        3,
    );
});

for (const fault of [
    'nonempty',
    'wrongIdentity',
    'queryFailure',
    'connectionFailure',
] as const) {
    void test(`later ${fault} fails closed, scrubs diagnostics and closes every opened connection`, async () => {
        const connector = fakeConnector({ [fault]: 'http' });
        await assert.rejects(
            openProjectAccessDatabases(kinds, environment, connector.connect),
            (error: Error) => {
                assert.ok(error instanceof HarnessFailure);
                assert.ok(!JSON.stringify(error).includes('secret'));
                assert.ok(!error.message.includes('postgresql'));
                assert.equal(error.cause, undefined);
                return true;
            },
        );
        assert.equal(
            connector.events.filter((event) => event.endsWith(':close')).length,
            fault === 'connectionFailure' ? 2 : 3,
        );
        for (const database of connector.databases) {
            await assert.rejects(deployMigrations(database, root), /preflight/);
            await assert.rejects(connectPrisma(database), /preflight/);
        }
    });
}

void test('unpreflighted validated URL cannot launch migrations or connect Prisma', async () => {
    const database = validateProjectAccessDatabase(
        'fresh',
        environment.PROJECT_ACCESS_TEST_DATABASE_URL,
    );
    await assert.rejects(deployMigrations(database, root), /preflight/);
    await assert.rejects(connectPrisma(database), /preflight/);
    assert.equal(new URL(explicitConnectionString(database)).port, '5432');
});

void test('assertion and driver errors are scrubbed while safe SQLSTATE is retained', async () => {
    for (const code of ['23514', 'P2002', 'secret']) {
        await assert.rejects(
            safeAcceptance('offline boundary', () =>
                Promise.reject(
                    Object.assign(
                        new Error(
                            'postgresql://secret:password@localhost/private',
                        ),
                        { code },
                    ),
                ),
            ),
            (error: HarnessFailure) => {
                assert.ok(error instanceof HarnessFailure);
                assert.equal(
                    error.sqlState,
                    code === 'secret' ? undefined : code,
                );
                assert.equal(error.cause, undefined);
                assert.ok(!error.message.includes('password'));
                return true;
            },
        );
    }
});

void test('historical migration staging preserves every file and adds compatibility before ACL', async () => {
    const directory = await stageLegacyMigrations();
    try {
        const expected = (
            await readdir(join(root, 'prisma/migrations'))
        ).sort();
        assert.deepEqual(
            (await readdir(directory)).sort(),
            expected.filter(
                (name) =>
                    name !== aclMigration &&
                    !compatibilityMigrations.some(
                        (migration) => migration === name,
                    ),
            ),
        );
        await assert.rejects(
            addMigrations(directory, ['../outside']),
            /acceptance plan/,
        );
        await addMigrations(directory, compatibilityMigrations);
        assert.ok(!(await readdir(directory)).includes(aclMigration));
        await addMigrations(directory, [aclMigration]);
        assert.deepEqual((await readdir(directory)).sort(), expected);
    } finally {
        await removeStagedMigrations(directory);
    }
});

void test('temporary cleanup refuses repository, traversed and merely prefix-matching unowned paths', async () => {
    for (const path of [
        root,
        join(tmpdir(), 'beacon-project-access-migrations-unowned'),
        join(tmpdir(), 'beacon-project-access-migrations-unowned', '..'),
    ]) {
        await assert.rejects(removeStagedMigrations(path), /unowned/);
    }
});

void test('genuine PrismaService exposes its external pool and disconnected teardown is idempotent with zero connections', async () => {
    const database = validateProjectAccessDatabase(
        'http',
        environment.PROJECT_ACCESS_HTTP_TEST_DATABASE_URL,
    );
    const handle = await disconnectedPrisma(database);
    assert.equal(handle.pool.totalCount, 0);
    assert.equal(handle.pool.waitingCount, 0);
    assert.equal(handle.close(), handle.close());
    await handle.close();
    assert.equal(handle.pool.totalCount, 0);
    assert.equal(handle.pool.ended, true);
});
