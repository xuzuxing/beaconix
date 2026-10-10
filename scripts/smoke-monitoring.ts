import 'dotenv/config';

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface WrappedResponse<T> {
    data: T;
    meta?: { timestamp: string };
}

interface AuthResponse {
    accessToken: string;
    refreshToken: string;
}

interface Organization {
    id: string;
    name: string;
    slug: string;
}

interface Project {
    id: string;
    name: string;
    key: string;
}

interface Monitor {
    id: string;
    name: string;
    status: string;
    target: string;
}

interface CheckExecution {
    monitorId: string;
    success: boolean;
    status: string;
    changed: boolean;
    notified: {
        skipped: boolean;
        sent: number;
        failed: number;
    };
}

interface MonitorState {
    monitorId: string;
    status: string;
    failCount: number;
    lastCheckAt: string | null;
    uptimePercent: number | null;
    avgLatency: number | null;
}

interface Paginated<T> {
    data: T[];
    meta: {
        total: number;
        page: number;
        limit: number;
        totalPages: number;
    };
}

interface CheckLog {
    id: string;
    monitorId: string;
    success: boolean;
    latency: number;
    source: string;
    checkedAt: string;
}

const API_URL = trimTrailingSlash(
    process.env.SMOKE_API_URL ?? 'http://localhost:3000/api',
);
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const TARGET = process.env.SMOKE_TARGET ?? 'https://example.com';
const KEEP_ORG = process.env.SMOKE_KEEP_ORG === 'true';

function trimTrailingSlash(value: string): string {
    return value.replace(/\/+$/, '');
}

function requireConfig(): void {
    const missing = [
        ['SMOKE_EMAIL', EMAIL],
        ['SMOKE_PASSWORD', PASSWORD],
    ].filter(([, value]) => !value);

    if (missing.length === 0) return;

    console.error('Missing required smoke-test environment variable(s):');
    for (const [key] of missing) {
        console.error(`  - ${key}`);
    }
    console.error('');
    console.error('Example:');
    console.error(
        '  $env:SMOKE_EMAIL="admin@example.com"; $env:SMOKE_PASSWORD="password"; pnpm smoke:monitoring',
    );
    process.exit(1);
}

async function request<T>(
    method: HttpMethod,
    path: string,
    options: { token?: string; body?: unknown; unwrap?: boolean } = {},
): Promise<T> {
    const headers: Record<string, string> = {
        Accept: 'application/json',
    };

    if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
    }

    if (options.token) {
        headers.Authorization = `Bearer ${options.token}`;
    }

    const response = await fetch(`${API_URL}${path}`, {
        method,
        headers,
        body:
            options.body === undefined
                ? undefined
                : JSON.stringify(options.body),
    });

    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;

    if (!response.ok) {
        throw new Error(
            `${method} ${path} failed with HTTP ${response.status}: ${text}`,
        );
    }

    if (options.unwrap === false) {
        return parsed as T;
    }

    return (parsed as WrappedResponse<T>).data;
}

function makeSlug(): string {
    const stamp = new Date()
        .toISOString()
        .replace(/[-:T.Z]/g, '')
        .slice(0, 14);
    const random = Math.random().toString(36).slice(2, 8);
    return `smoke-${stamp}-${random}`;
}

async function cleanupOrg(token: string, org: Organization | null) {
    if (!org || KEEP_ORG) return;

    try {
        await request<Organization>('DELETE', `/organizations/${org.id}`, {
            token,
        });
        console.log(`Cleaned up organization: ${org.slug}`);
    } catch (error) {
        console.warn(
            `Cleanup failed for organization ${org.slug}: ${(error as Error).message}`,
        );
    }
}

async function main() {
    requireConfig();

    let token = '';
    let org: Organization | null = null;

    try {
        console.log(`Smoke API: ${API_URL}`);
        console.log(`Monitor target: ${TARGET}`);

        const auth = await request<AuthResponse>('POST', '/auth/login', {
            body: { email: EMAIL, password: PASSWORD },
        });
        token = auth.accessToken;
        console.log('Logged in');

        const slug = makeSlug();
        org = await request<Organization>('POST', '/organizations', {
            token,
            body: {
                name: `Smoke Monitoring ${slug}`,
                slug,
                description: 'Temporary organization created by smoke test',
            },
        });
        console.log(`Created organization: ${org.slug} (${org.id})`);

        const project = await request<Project>(
            'POST',
            `/organizations/${org.id}/projects`,
            {
                token,
                body: {
                    name: 'Smoke Monitoring Project',
                    key: 'SMOKE',
                    description: 'Temporary project created by smoke test',
                },
            },
        );
        console.log(`Created project: ${project.key} (${project.id})`);

        const monitor = await request<Monitor>(
            'POST',
            `/projects/${project.id}/monitors`,
            {
                token,
                body: {
                    name: 'Smoke HTTP Monitor',
                    type: 'HTTP',
                    target: TARGET,
                    interval: 60,
                    timeout: 10000,
                    expectedStatus: 200,
                    failureThreshold: 2,
                    enabled: true,
                },
            },
        );
        console.log(`Created monitor: ${monitor.id}`);

        const check = await request<CheckExecution>(
            'POST',
            `/projects/${project.id}/monitors/${monitor.id}/check`,
            { token },
        );
        console.log(
            `Manual check: success=${check.success} status=${check.status} changed=${check.changed}`,
        );

        const state = await request<MonitorState>(
            'GET',
            `/projects/${project.id}/monitors/${monitor.id}/state`,
            { token },
        );
        console.log(
            `State: status=${state.status} failCount=${state.failCount} uptime24h=${state.uptimePercent ?? 'n/a'} avgLatency=${state.avgLatency ?? 'n/a'}`,
        );

        const logs = await request<Paginated<CheckLog>>(
            'GET',
            `/projects/${project.id}/monitors/${monitor.id}/checks?limit=5`,
            { token },
        );
        console.log(`Check logs: ${logs.meta.total}`);

        if (logs.meta.total < 1) {
            throw new Error('Expected at least one check log after manual check');
        }

        await request<Monitor>(
            'DELETE',
            `/projects/${project.id}/monitors/${monitor.id}`,
            { token },
        );
        console.log(`Soft-deleted monitor: ${monitor.id}`);

        console.log('Monitoring smoke test passed');
    } finally {
        if (token) {
            await cleanupOrg(token, org);
        }
    }
}

void main().catch((error) => {
    console.error('Monitoring smoke test failed');
    console.error((error as Error).message);
    process.exit(1);
});
