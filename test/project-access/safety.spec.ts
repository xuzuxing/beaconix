import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    assertEmptyProjectAccessDatabase,
    assertProjectAccessDatabaseIdentity,
    preflightProjectAccessDatabases,
    PROJECT_ACCESS_DATABASES,
    readProjectAccessDatabases,
    validateProjectAccessDatabase,
    validateProjectAccessDatabaseKind,
    type DatabaseSafetyClient,
    type ProjectAccessDatabaseKind,
} from './database-safety';

const kinds: ProjectAccessDatabaseKind[] = ['fresh', 'upgrade', 'http'];
const credential = 'synthetic-test-password';
const urlFor = (
    kind: ProjectAccessDatabaseKind,
    host = 'localhost',
    suffix = '',
) =>
    `postgresql://fixture:${credential}@${host}:5432/${PROJECT_ACCESS_DATABASES[kind].prefix}${suffix}`;

for (const kind of kinds) {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        for (const suffix of ['', '_ci_01']) {
            void test(`${kind}: accepts explicit disposable URL (${host}, ${suffix || 'base'})`, () => {
                const value = urlFor(kind, host, suffix);
                const result = validateProjectAccessDatabase(kind, value);
                assert.equal(result.connectionString, value);
                assert.equal(result.kind, kind);
                assert.equal(
                    result.database,
                    `${PROJECT_ACCESS_DATABASES[kind].prefix}${suffix}`,
                );
                assert.equal(result.port, '5432');
            });
        }
    }
    const safe = urlFor(kind);
    const unsafeValues = [
        undefined,
        '',
        'invalid database URL',
        ` ${safe}`,
        `${safe} `,
        safe.replace('postgresql:', 'https:'),
        safe.replace('localhost', 'db.example.test'),
        safe.replace('localhost', '127.0.0.2'),
        safe.replace('localhost', 'localhost.example.test'),
        safe.replace('localhost', 'localhost.'),
        safe.replace(PROJECT_ACCESS_DATABASES[kind].prefix, 'beaconix'),
        safe.replace(PROJECT_ACCESS_DATABASES[kind].prefix, 'postgres'),
        `${safe}/extra`,
        `${safe}_UPPERCASE`,
        `${safe}_`,
        `${safe}%5Fci`,
        `${safe}?schema=public`,
        `${safe}?host=db.example.test`,
        `${safe}?`,
        `${safe}#fragment`,
        `${safe}#`,
        ...kinds
            .filter((other) => other !== kind)
            .map((other) => urlFor(other)),
    ];
    unsafeValues.forEach((value, index) => {
        void test(`${kind}: refuses unsafe URL case ${index + 1} without exposing credentials`, () => {
            assert.throws(
                () => validateProjectAccessDatabase(kind, value),
                (error: Error) =>
                    error.message.includes(
                        PROJECT_ACCESS_DATABASES[kind].variable,
                    ) &&
                    error.message.includes('No DATABASE_URL fallback') &&
                    !error.message.includes(credential) &&
                    !error.message.includes('postgresql://'),
            );
        });
    });
}

void test('accepts both PostgreSQL protocol names and explicit custom ports', () => {
    const value = urlFor('fresh')
        .replace('postgresql:', 'postgres:')
        .replace(':5432/', ':55432/');
    assert.equal(validateProjectAccessDatabase('fresh', value).port, '55432');
});

void test('an omitted port resolves to the PostgreSQL default', () => {
    assert.equal(
        validateProjectAccessDatabase(
            'fresh',
            urlFor('fresh').replace(':5432/', '/'),
        ).port,
        '5432',
    );
});

for (const kind of kinds) {
    void test(`accepts explicit migration kind ${kind}`, () => {
        assert.equal(validateProjectAccessDatabaseKind(kind), kind);
    });
}
for (const kind of [undefined, '', 'production', 'FRESH']) {
    void test(`rejects missing or invalid migration kind (${kind ?? 'missing'})`, () => {
        assert.throws(() => validateProjectAccessDatabaseKind(kind));
    });
}

void test('reads three separate disposable databases without consulting DATABASE_URL', () => {
    const databases = readProjectAccessDatabases(kinds, {
        PROJECT_ACCESS_TEST_DATABASE_URL: urlFor('fresh'),
        PROJECT_ACCESS_UPGRADE_TEST_DATABASE_URL: urlFor('upgrade'),
        PROJECT_ACCESS_HTTP_TEST_DATABASE_URL: urlFor('http'),
        DATABASE_URL: 'must-not-be-consulted',
    });
    assert.equal(databases.length, 3);
    assert.equal(new Set(databases.map((item) => item.database)).size, 3);
});

void test('missing test URL never falls back to the application datasource', () => {
    assert.throws(
        () =>
            readProjectAccessDatabases(['fresh'], {
                DATABASE_URL: urlFor('fresh'),
            }),
        /No DATABASE_URL fallback/,
    );
});

void test('integration preflight requires both new-install and upgrade configuration', () => {
    assert.throws(() =>
        readProjectAccessDatabases(['fresh', 'upgrade'], {
            PROJECT_ACCESS_TEST_DATABASE_URL: urlFor('fresh'),
        }),
    );
});

void test('HTTP preflight does not require integration databases', () => {
    assert.equal(
        readProjectAccessDatabases(['http'], {
            PROJECT_ACCESS_HTTP_TEST_DATABASE_URL: urlFor('http'),
        }).length,
        1,
    );
});

void test('rejects empty or duplicate scenario selection', () => {
    assert.throws(() => readProjectAccessDatabases([], {}));
    assert.throws(() => readProjectAccessDatabases(['fresh', 'fresh'], {}));
});

void test('runtime database identity must match the validated URL', async () => {
    let observedSql = '';
    const client: DatabaseSafetyClient = {
        query: (sql) => {
            observedSql = sql;
            return Promise.resolve({
                rows: [{ database: PROJECT_ACCESS_DATABASES.fresh.prefix }],
            });
        },
    };
    await assertProjectAccessDatabaseIdentity(
        client,
        validateProjectAccessDatabase('fresh', urlFor('fresh')),
    );
    assert.equal(observedSql, 'SELECT current_database() AS database');
});

void test('refuses a miswired runtime database before checking objects', async () => {
    let queries = 0;
    const client: DatabaseSafetyClient = {
        query: () => {
            queries++;
            return Promise.resolve({ rows: [{ database: 'beaconix' }] });
        },
    };
    await assert.rejects(
        preflightProjectAccessDatabases(
            [validateProjectAccessDatabase('fresh', urlFor('fresh'))],
            [client],
        ),
        /runtime datasource/,
    );
    assert.equal(queries, 1);
});

for (const rows of [[], [{ database: 'wrong' }], [{ database: 42 }]]) {
    void test(`refuses invalid database identity result (${JSON.stringify(rows)})`, async () => {
        await assert.rejects(
            assertProjectAccessDatabaseIdentity(
                { query: () => Promise.resolve({ rows }) },
                validateProjectAccessDatabase('http', urlFor('http')),
            ),
            /runtime datasource/,
        );
    });
}

void test('accepts an empty database using read-only catalog queries', async () => {
    let observedSql = '';
    await assertEmptyProjectAccessDatabase({
        query: (sql) => {
            observedSql = sql;
            return Promise.resolve({ rows: [] });
        },
    });
    for (const catalog of ['pg_class', 'pg_type', 'pg_proc', 'pg_namespace']) {
        assert.ok(observedSql.includes(catalog));
    }
    assert.ok(!/\b(DROP|CREATE|DELETE|TRUNCATE|ALTER)\b/i.test(observedSql));
});

void test('refuses a nonempty database without attempting cleanup', async () => {
    let queries = 0;
    await assert.rejects(
        assertEmptyProjectAccessDatabase({
            query: () => {
                queries++;
                return Promise.resolve({ rows: [{ exists: 1 }] });
            },
        }),
        /nonempty/,
    );
    assert.equal(queries, 1);
});

void test('checks every required empty database before returning control for migration', async () => {
    const databases = kinds.map((kind) =>
        validateProjectAccessDatabase(kind, urlFor(kind)),
    );
    const observed: string[] = [];
    const clients = databases.map((database): DatabaseSafetyClient => ({
        query: (sql) => {
            observed.push(database.kind);
            return Promise.resolve({
                rows: sql.includes('current_database()')
                    ? [{ database: database.database }]
                    : [],
            });
        },
    }));
    await preflightProjectAccessDatabases(databases, clients);
    assert.deepEqual(observed, [
        'fresh',
        'fresh',
        'upgrade',
        'upgrade',
        'http',
        'http',
    ]);
});

void test('refuses a nonempty second database before caller can start any DDL', async () => {
    const databases = readProjectAccessDatabases(['fresh', 'upgrade'], {
        PROJECT_ACCESS_TEST_DATABASE_URL: urlFor('fresh'),
        PROJECT_ACCESS_UPGRADE_TEST_DATABASE_URL: urlFor('upgrade'),
    });
    let migrations = 0;
    const clients = databases.map((database): DatabaseSafetyClient => ({
        query: (sql) =>
            Promise.resolve({
                rows: sql.includes('current_database()')
                    ? [{ database: database.database }]
                    : database.kind === 'upgrade'
                      ? [{ exists: 1 }]
                      : [],
            }),
    }));
    await assert.rejects(
        (async () => {
            await preflightProjectAccessDatabases(databases, clients);
            migrations++;
        })(),
        /nonempty/,
    );
    assert.equal(migrations, 0);
});

void test('refuses a missing runtime client before querying any database', async () => {
    const database = validateProjectAccessDatabase('fresh', urlFor('fresh'));
    await assert.rejects(
        preflightProjectAccessDatabases([database], []),
        /runtime client/,
    );
    await assert.rejects(
        preflightProjectAccessDatabases([], []),
        /runtime client/,
    );
});

void test('preflight refuses duplicate scenarios without querying the client', async () => {
    const database = validateProjectAccessDatabase('fresh', urlFor('fresh'));
    let queries = 0;
    const client: DatabaseSafetyClient = {
        query: () => {
            queries++;
            return Promise.resolve({ rows: [] });
        },
    };
    await assert.rejects(
        preflightProjectAccessDatabases([database, database], [client, client]),
        /distinct database scenarios/,
    );
    assert.equal(queries, 0);
});

void test('preflight revalidates URLs and refuses inconsistent metadata before queries', async () => {
    const database = validateProjectAccessDatabase('fresh', urlFor('fresh'));
    let queries = 0;
    const client: DatabaseSafetyClient = {
        query: () => {
            queries++;
            return Promise.resolve({ rows: [] });
        },
    };
    await assert.rejects(
        preflightProjectAccessDatabases(
            [{ ...database, database: 'beaconix' }],
            [client],
        ),
        /metadata/,
    );
    await assert.rejects(
        preflightProjectAccessDatabases(
            [{ ...database, connectionString: 'not a database URL' }],
            [client],
        ),
        /No DATABASE_URL fallback/,
    );
    assert.equal(queries, 0);
});

for (const check of ['identity', 'catalog'] as const) {
    void test(`${check}: replaces rejected driver errors without retaining credentials or cause`, async () => {
        const original = new Error(`Connection failed: ${urlFor('fresh')}`, {
            cause: new Error(`Driver diagnostics: ${credential}`),
        });
        const client: DatabaseSafetyClient = {
            query: () => Promise.reject(original),
        };
        await assert.rejects(
            check === 'identity'
                ? assertProjectAccessDatabaseIdentity(
                      client,
                      validateProjectAccessDatabase('fresh', urlFor('fresh')),
                  )
                : assertEmptyProjectAccessDatabase(client),
            (error: Error) => {
                assert.notEqual(error, original);
                assert.ok(!error.message.includes(credential));
                assert.ok(!error.stack?.includes(credential));
                assert.ok(!error.message.includes('postgresql://'));
                assert.equal(error.cause, undefined);
                return error.message.includes('Refusing database work');
            },
        );
    });
}
