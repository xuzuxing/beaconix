export const PROJECT_ACCESS_DATABASES = {
    fresh: {
        variable: 'PROJECT_ACCESS_TEST_DATABASE_URL',
        prefix: 'beacon_project_access_test',
    },
    upgrade: {
        variable: 'PROJECT_ACCESS_UPGRADE_TEST_DATABASE_URL',
        prefix: 'beacon_project_access_upgrade_test',
    },
    http: {
        variable: 'PROJECT_ACCESS_HTTP_TEST_DATABASE_URL',
        prefix: 'beacon_project_access_http_test',
    },
} as const;

export type ProjectAccessDatabaseKind = keyof typeof PROJECT_ACCESS_DATABASES;

export interface ValidatedProjectAccessDatabase {
    kind: ProjectAccessDatabaseKind;
    connectionString: string;
    database: string;
    port: string;
}

export interface DatabaseSafetyClient {
    query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}

async function safetyQuery(
    client: DatabaseSafetyClient,
    sql: string,
    refusal: string,
): Promise<{ rows: Record<string, unknown>[] }> {
    try {
        return await client.query(sql);
    } catch {
        // Never retain a driver error or cause that may contain credentials.
        throw new Error(refusal);
    }
}

export function validateProjectAccessDatabase(
    kind: ProjectAccessDatabaseKind,
    value: string | undefined,
): ValidatedProjectAccessDatabase {
    const policy = PROJECT_ACCESS_DATABASES[kind];
    const refusal = `${policy.variable} must identify an explicit disposable local PostgreSQL database named ${policy.prefix} or ${policy.prefix}_<suffix>. No DATABASE_URL fallback is allowed.`;
    if (!value || value.trim() !== value) throw new Error(refusal);

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        // The parser's exception may include the original credential-bearing URL.
        throw new Error(refusal);
    }
    if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        !new RegExp(`^/${policy.prefix}(?:_[a-z0-9_]+)?$`).test(url.pathname) ||
        value.includes('?') ||
        value.includes('#')
    ) {
        throw new Error(refusal);
    }

    return {
        kind,
        connectionString: value,
        database: url.pathname.slice(1),
        port: url.port || '5432',
    };
}

export function validateProjectAccessDatabaseKind(
    value: string | undefined,
): ProjectAccessDatabaseKind {
    if (value !== 'fresh' && value !== 'upgrade' && value !== 'http') {
        throw new Error(
            'PROJECT_ACCESS_TEST_KIND must be fresh, upgrade, or http.',
        );
    }
    return value;
}

export function readProjectAccessDatabases(
    kinds: readonly ProjectAccessDatabaseKind[],
    environment: Readonly<Record<string, string | undefined>> = process.env,
): ValidatedProjectAccessDatabase[] {
    if (!kinds.length || new Set(kinds).size !== kinds.length) {
        throw new Error(
            'Request at least one distinct project-access database kind.',
        );
    }
    const databases = kinds.map((kind) =>
        validateProjectAccessDatabase(
            kind,
            environment[PROJECT_ACCESS_DATABASES[kind].variable],
        ),
    );
    // Loopback aliases are conservatively treated as the same server.
    const identities = databases.map((item) => `${item.port}/${item.database}`);
    if (new Set(identities).size !== identities.length) {
        throw new Error(
            'Project-access test scenarios must use distinct databases.',
        );
    }
    return databases;
}

export async function assertProjectAccessDatabaseIdentity(
    client: DatabaseSafetyClient,
    database: ValidatedProjectAccessDatabase,
): Promise<void> {
    const result = await safetyQuery(
        client,
        'SELECT current_database() AS database',
        `${PROJECT_ACCESS_DATABASES[database.kind].variable} runtime identity check failed. Refusing database work.`,
    );
    if (
        result.rows.length !== 1 ||
        result.rows[0].database !== database.database
    ) {
        throw new Error(
            `${PROJECT_ACCESS_DATABASES[database.kind].variable} does not match the runtime datasource. Refusing database work.`,
        );
    }
}

export async function assertEmptyProjectAccessDatabase(
    client: DatabaseSafetyClient,
): Promise<void> {
    const result = await safetyQuery(
        client,
        `
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        UNION ALL
        SELECT 1 FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        UNION ALL
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        UNION ALL
        SELECT 1 FROM pg_namespace n
        WHERE n.nspname !~ '^pg_'
          AND n.nspname NOT IN ('information_schema', 'public')
        LIMIT 1
    `,
        'Project-access test database catalog preflight failed. Refusing database work.',
    );
    if (result.rows.length) {
        throw new Error(
            'Refusing a nonempty project-access test database. Provide a new empty disposable database; this helper never resets or drops objects.',
        );
    }
}

export async function preflightProjectAccessDatabases(
    databases: readonly ValidatedProjectAccessDatabase[],
    clients: readonly DatabaseSafetyClient[],
): Promise<void> {
    if (!databases.length || databases.length !== clients.length) {
        throw new Error(
            'Every project-access test database requires its own runtime client.',
        );
    }
    const validated = databases.map((database) =>
        validateProjectAccessDatabase(database.kind, database.connectionString),
    );
    if (
        new Set(validated.map((database) => database.kind)).size !==
        validated.length
    ) {
        throw new Error(
            'Project-access preflight requires distinct database scenarios.',
        );
    }
    for (let index = 0; index < databases.length; index++) {
        if (
            validated[index].database !== databases[index].database ||
            validated[index].port !== databases[index].port
        ) {
            throw new Error(
                'Project-access datasource metadata does not match its validated URL.',
            );
        }
    }
    for (let index = 0; index < validated.length; index++) {
        await assertProjectAccessDatabaseIdentity(
            clients[index],
            validated[index],
        );
        await assertEmptyProjectAccessDatabase(clients[index]);
    }
}
