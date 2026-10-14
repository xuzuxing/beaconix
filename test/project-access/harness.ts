import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';
import { Client, type Pool, type QueryResultRow } from 'pg';
import {
    preflightProjectAccessDatabases,
    readProjectAccessDatabases,
    validateProjectAccessDatabase,
    type DatabaseSafetyClient,
    type ProjectAccessDatabaseKind,
    type ValidatedProjectAccessDatabase,
} from './database-safety';

const execute = promisify(execFile);
export const root = resolve(__dirname, '../..');
export const aclMigration = '20261012120000_project_access_control';
export const compatibilityMigrations = [
    '20261010000100_local_monitor_types',
    '20261010000200_monitor_plan_types',
    '20261010000300_application_monitor_types',
    '20261010000400_application_monitor_plans',
    '20261011100000_merge_monitor_revision_tracking',
] as const;
const allKinds = ['fresh', 'upgrade', 'http'] as const;
const temporaryPrefix = 'beaconix-project-access-migrations-';
const preflightedDatabases = new WeakSet<ValidatedProjectAccessDatabase>();
const stagedDirectories = new Set<string>();

export class HarnessFailure extends Error {
    constructor(
        message: string,
        readonly sqlState?: string,
    ) {
        super(message);
        this.name = 'HarnessFailure';
    }
}

function errorCode(error: unknown): string | undefined {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' && /^(?:[0-9A-Z]{5}|P[0-9]{4})$/.test(code)
        ? code
        : undefined;
}

export async function safeAcceptance<T>(
    label: string,
    work: () => Promise<T>,
): Promise<T> {
    try {
        return await work();
    } catch (error) {
        if (error instanceof HarnessFailure) throw error;
        // Do not preserve driver diagnostics, assertion actuals, or a raw cause.
        const code = errorCode(error);
        throw new HarnessFailure(
            `${label} failed${code ? ` (${code})` : ''}. No connection diagnostics are logged.`,
            code,
        );
    }
}

export function acceptanceCase(
    context: TestContext,
    label: string,
    work: () => Promise<void>,
) {
    return context.test(label, () => safeAcceptance(label, work));
}

export interface SqlDatabase extends DatabaseSafetyClient {
    database: ValidatedProjectAccessDatabase;
    query<T extends QueryResultRow = Record<string, unknown>>(
        sql: string,
        values?: unknown[],
    ): Promise<{ rows: T[]; rowCount: number | null }>;
    close(): Promise<void>;
}

export function explicitConnectionString(
    database: ValidatedProjectAccessDatabase,
): string {
    validateProjectAccessDatabase(database.kind, database.connectionString);
    const url = new URL(database.connectionString);
    // pg must not obtain the omitted port from an ambient PGPORT.
    url.port = database.port;
    return url.toString();
}

export async function connectDatabase(
    database: ValidatedProjectAccessDatabase,
): Promise<SqlDatabase> {
    validateProjectAccessDatabase(database.kind, database.connectionString);
    const client = new Client({
        connectionString: explicitConnectionString(database),
        connectionTimeoutMillis: 5000,
        query_timeout: 15_000,
        application_name: 'beaconix-project-access-acceptance',
    });
    client.on('error', () => {
        // Query/connect failures are reported through the scrubbed boundary.
    });
    try {
        await client.connect();
    } catch {
        await client.end().catch(() => undefined);
        throw new HarnessFailure(
            `${database.kind} disposable database connection failed. Refusing database work.`,
        );
    }
    return {
        database,
        async query<T extends QueryResultRow>(sql: string, values?: unknown[]) {
            try {
                const result = await client.query<T>(sql, values);
                return { rows: result.rows, rowCount: result.rowCount };
            } catch (error) {
                throw new HarnessFailure(
                    `${database.kind} disposable database query failed.`,
                    errorCode(error),
                );
            }
        },
        async close() {
            try {
                await client.end();
            } catch {
                throw new HarnessFailure('Disposable database close failed.');
            }
        },
    };
}

export async function openProjectAccessDatabases(
    kinds: readonly ProjectAccessDatabaseKind[],
    environment: Readonly<Record<string, string | undefined>> = process.env,
    connect = connectDatabase,
) {
    // Validate all three URLs, including distinct identities, before connecting.
    // Each suite checks emptiness only for its own scenarios; a preceding suite
    // is allowed to leave its other disposable databases populated.
    readProjectAccessDatabases(allKinds, environment);
    const databases = readProjectAccessDatabases(kinds, environment).map(
        (database) => Object.freeze(database),
    );
    const connections: SqlDatabase[] = [];
    try {
        for (const database of databases) {
            connections.push(await connect(database));
        }
        await preflightProjectAccessDatabases(databases, connections);
        for (const database of databases) {
            preflightedDatabases.add(database);
        }
    } catch (error) {
        await Promise.allSettled(connections.map((client) => client.close()));
        if (error instanceof HarnessFailure) throw error;
        throw new HarnessFailure(
            'Disposable database preflight failed. Refusing database work.',
        );
    }
    return {
        connections,
        get(kind: ProjectAccessDatabaseKind) {
            const connection = connections.find(
                (item) => item.database.kind === kind,
            );
            if (!connection)
                throw new HarnessFailure('Database not preflighted.');
            return connection;
        },
        async close() {
            for (const database of databases)
                preflightedDatabases.delete(database);
            const results = await Promise.allSettled(
                connections.map((client) => client.close()),
            );
            if (results.some((result) => result.status === 'rejected')) {
                throw new HarnessFailure(
                    'Disposable database teardown failed.',
                );
            }
        },
    };
}

function assertStagedDirectory(directory: string) {
    const path = resolve(directory);
    if (
        dirname(path) !== resolve(tmpdir()) ||
        !basename(path).startsWith(temporaryPrefix) ||
        !stagedDirectories.has(path)
    ) {
        throw new HarnessFailure('Refusing an unowned migration directory.');
    }
    return path;
}

export async function removeStagedMigrations(directory: string) {
    const path = assertStagedDirectory(directory);
    await rm(path, { recursive: true, force: true });
    stagedDirectories.delete(path);
}

export async function stageLegacyMigrations(): Promise<string> {
    const source = join(root, 'prisma/migrations');
    const target = await mkdtemp(join(tmpdir(), temporaryPrefix));
    stagedDirectories.add(resolve(target));
    try {
        for (const entry of await readdir(source, { withFileTypes: true })) {
            if (
                entry.name === 'migration_lock.toml' ||
                (entry.isDirectory() &&
                    entry.name !== aclMigration &&
                    !compatibilityMigrations.some(
                        (name) => name === entry.name,
                    ))
            ) {
                await cp(join(source, entry.name), join(target, entry.name), {
                    recursive: true,
                });
            }
        }
        return target;
    } catch {
        await removeStagedMigrations(target);
        throw new HarnessFailure('Legacy migration staging failed.');
    }
}

export async function addMigrations(target: string, names: readonly string[]) {
    assertStagedDirectory(target);
    for (const name of names) {
        if (
            name !== aclMigration &&
            !compatibilityMigrations.some((candidate) => candidate === name)
        ) {
            throw new HarnessFailure(
                'Migration is not in the acceptance plan.',
            );
        }
        await cp(join(root, 'prisma/migrations', name), join(target, name), {
            recursive: true,
        });
    }
}

export async function deployMigrations(
    database: ValidatedProjectAccessDatabase,
    directory: string,
) {
    if (!preflightedDatabases.has(database)) {
        throw new HarnessFailure(
            'Migrations require successful whole-suite preflight.',
        );
    }
    validateProjectAccessDatabase(database.kind, database.connectionString);
    assertStagedDirectory(directory);
    const environment = { ...process.env };
    delete environment.DATABASE_URL;
    delete environment.DEBUG;
    delete environment.NODE_OPTIONS;
    environment.PROJECT_ACCESS_TEST_KIND = database.kind;
    environment.PROJECT_ACCESS_TEST_MIGRATIONS_DIR = directory;
    const variables = {
        fresh: 'PROJECT_ACCESS_TEST_DATABASE_URL',
        upgrade: 'PROJECT_ACCESS_UPGRADE_TEST_DATABASE_URL',
        http: 'PROJECT_ACCESS_HTTP_TEST_DATABASE_URL',
    } as const;
    environment[variables[database.kind]] = explicitConnectionString(database);
    try {
        await execute(
            process.execPath,
            [
                join(root, 'node_modules/prisma/build/index.js'),
                'migrate',
                'deploy',
                '--config',
                join(__dirname, 'prisma.config.ts'),
            ],
            {
                cwd: root,
                env: environment,
                timeout: 120_000,
                maxBuffer: 4 * 1024 * 1024,
                windowsHide: true,
            },
        );
    } catch {
        throw new HarnessFailure(
            `${database.kind} acceptance migration deployment failed. Child-process output is withheld because it may contain credentials.`,
        );
    }
}

export async function deployLegacyBaseline(
    database: ValidatedProjectAccessDatabase,
    directory: string,
) {
    await deployMigrations(database, directory);
    // Match the historical monitor upgrade: base/history first, protocol
    // columns second, then the trigger compatibility replacement. Never omit
    // these migrations from the schema used by the generated current client.
    await addMigrations(directory, compatibilityMigrations);
    await deployMigrations(database, directory);
}

export async function disconnectedPrisma(
    database: ValidatedProjectAccessDatabase,
) {
    validateProjectAccessDatabase(database.kind, database.connectionString);
    const { ConfigService } = await import('@nestjs/config');
    const { Logger } = await import('@nestjs/common');
    const { PrismaService } =
        await import('../../src/infra/database/prisma.service.js');
    Logger.overrideLogger(false);
    const prisma = new PrismaService(
        new ConfigService({
            database: { url: explicitConnectionString(database) },
            app: { isDevelopment: false },
        }),
    );
    // PrismaService supplies an external pg Pool, which $disconnect alone
    // does not own. Capture it for explicit test teardown, without replacing
    // the genuine PrismaService or any of its delegates.
    const engine = Reflect.get(prisma, '_engineConfig') as {
        adapter?: { externalPool?: Pool };
    };
    const pool = engine?.adapter?.externalPool;
    if (!pool || typeof pool.end !== 'function') {
        throw new HarnessFailure(
            'Cannot verify Prisma pool teardown ownership.',
        );
    }
    let closing: Promise<void> | undefined;
    const close = () =>
        (closing ??= safeAcceptance('Prisma pool teardown', async () => {
            try {
                await prisma.$disconnect();
            } finally {
                await pool.end();
            }
        }));
    return { prisma, close, pool };
}

export async function connectPrisma(database: ValidatedProjectAccessDatabase) {
    if (!preflightedDatabases.has(database)) {
        throw new HarnessFailure(
            'Prisma requires successful whole-suite preflight.',
        );
    }
    const handle = await disconnectedPrisma(database);
    const { prisma, close } = handle;
    try {
        await prisma.$connect();
        const rows = await prisma.$queryRaw<{ database: string }[]>`
            SELECT current_database() AS database
        `;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].database, database.database);
    } catch {
        await close().catch(() => undefined);
        throw new HarnessFailure(
            'Prisma runtime identity/connection verification failed. Refusing fixtures and HTTP requests.',
        );
    }
    return handle;
}

export async function waitForDatabaseBlock(
    observer: SqlDatabase,
    blockerPid: number,
    timeoutMs = 5000,
) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const { rows } = await observer.query<{ blocked: boolean }>(
            'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked',
            [blockerPid],
        );
        if (rows[0]?.blocked) return;
        // Yield while polling actual PostgreSQL lock state, not a sleep-based
        // assertion that a transaction is "probably" blocked.
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new HarnessFailure('Expected PostgreSQL lock wait was not observed.');
}
