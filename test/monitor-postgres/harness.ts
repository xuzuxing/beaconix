import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'pg';

const execute = promisify(execFile);
export const root = resolve(__dirname, '../..');
export const localMigrations = [
    '20261010000100_local_monitor_types',
    '20261010000200_monitor_plan_types',
    '20261010000300_application_monitor_types',
    '20261010000400_application_monitor_plans',
] as const;
const compatibilityMigrations = [
    '20261011100000_merge_monitor_revision_tracking',
] as const;

export function validateTestUrl(value: string | undefined): string {
    const refusal =
        'Set MONITOR_TEST_DATABASE_URL to an empty, disposable local PostgreSQL database named beacon_monitor_test (or beacon_monitor_test_<suffix>). No DATABASE_URL fallback is allowed.';
    if (!value) throw new Error(refusal);
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(refusal);
    }
    if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        !/^\/beacon_monitor_test(?:_[a-z0-9_]+)?$/.test(url.pathname) ||
        url.search ||
        url.hash
    ) {
        throw new Error(refusal);
    }
    return value;
}

export async function assertEmptyDatabase(client: Client): Promise<void> {
    const objects = await client.query(`
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        UNION ALL
        SELECT 1 FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        LIMIT 1
    `);
    if (objects.rows.length) {
        throw new Error(
            'Refusing nonempty test database. Create a new disposable database; this harness never resets or drops database objects.',
        );
    }
}

export async function stageMigrations(): Promise<string> {
    const source = join(root, 'prisma/migrations');
    const target = await mkdtemp(join(tmpdir(), 'beaconix-monitor-migrations-'));
    try {
        for (const entry of await readdir(source, { withFileTypes: true })) {
            if (
                (entry.isDirectory() &&
                    ![...localMigrations, ...compatibilityMigrations].some(
                        (name) => name === entry.name,
                    )) ||
                entry.name === 'migration_lock.toml'
            ) {
                await cp(join(source, entry.name), join(target, entry.name), {
                    recursive: true,
                });
            }
        }
        return target;
    } catch (error) {
        await removeStagedMigrations(target);
        throw error;
    }
}

export async function addLocalMigrations(target: string): Promise<void> {
    for (const name of [...localMigrations, ...compatibilityMigrations]) {
        await cp(join(root, 'prisma/migrations', name), join(target, name), {
            recursive: true,
        });
    }
}

export async function removeStagedMigrations(target: string): Promise<void> {
    const path = resolve(target);
    if (
        dirname(path) !== resolve(tmpdir()) ||
        !basename(path).startsWith('beaconix-monitor-migrations-')
    ) {
        throw new Error(
            'Refusing cleanup outside the temporary migration folder',
        );
    }
    await rm(path, { recursive: true, force: true });
}

export async function deployMigrations(
    databaseUrl: string,
    migrations: string,
): Promise<void> {
    validateTestUrl(databaseUrl);
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
                timeout: 60_000,
                maxBuffer: 4 * 1024 * 1024,
                windowsHide: true,
                env: {
                    ...process.env,
                    DATABASE_URL: databaseUrl,
                    MONITOR_TEST_DATABASE_URL: databaseUrl,
                    MONITOR_TEST_MIGRATIONS_DIR: migrations,
                },
            },
        );
    } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        const password = decodeURIComponent(new URL(databaseUrl).password);
        let details =
            `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`.replaceAll(
                databaseUrl,
                '[test database]',
            );
        if (password) details = details.replaceAll(password, '[redacted]');
        // eslint-disable-next-line preserve-caught-error -- Raw child-process errors may expose credentials; only redacted diagnostics can escape.
        throw new Error(`Test migration deployment failed:\n${details}`);
    }
}
