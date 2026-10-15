import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/infra/database/prisma.service';
import { MultiLevelCacheService } from '../src/infra/cache/multi-level-cache.service';
import { TransformInterceptor } from '../src/common/interceptors';
import { StatusPagesPublicController } from '../src/modules/status-pages/status-pages-public.controller';
import { StatusPagesService } from '../src/modules/status-pages/status-pages.service';
import { PublicStatusEtagInterceptor } from '../src/modules/status-pages/public-status-etag.interceptor';
import { QuotaService } from '../src/shared/quota/quota.service';

const databaseUrl = process.env.MONITORING_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const DAY_MS = 86_400_000;

interface AvailabilityPayload {
    tz: string;
    asOf: string;
    days: string[];
    hours: number[];
    cells: [number, number, number][];
    unavailableCells: [number, number][];
    worst: { day: string; hour: number; value: number } | null;
    history: { retentionDays: number; availableFrom: string; status: string };
}

interface MonitorPayload {
    id: string;
    uptimePercent?: number | null;
    availability?: AvailabilityPayload;
}

suite('Public status page hourly availability (PostgreSQL + real HTTP)', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let base: string;
    let slug: string;
    let organizationId: string;
    let userId: string;
    let projectA: string;
    let projectB: string;
    let monitorA: string;
    let monitorB: string;
    const cache = new Map<string, unknown>();
    const prefix = `status-page-e2e-${randomUUID()}`;
    const now = new Date();

    const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);
    /** A UTC hour bucket on a day counted back from today. */
    const utcHour = (back: number, hour: number) =>
        new Date(
            Date.UTC(
                now.getUTCFullYear(),
                now.getUTCMonth(),
                now.getUTCDate() - back,
                hour,
            ),
        );

    const api = async (
        query = '',
        headers: Record<string, string> = {},
    ): Promise<{
        status: number;
        headers: Headers;
        body: {
            data: {
                monitors: MonitorPayload[];
                slug: string;
            };
        };
        text: string;
    }> => {
        const response = await fetch(`${base}/api/status/${slug}${query}`, {
            headers,
        });
        const text = await response.text();
        return {
            status: response.status,
            headers: response.headers,
            body: text ? JSON.parse(text) : null,
            text,
        };
    };

    const checkRow = (
        monitorId: string,
        projectId: string,
        checkedAt: Date,
        success: boolean,
    ) => ({
        monitorId,
        monitorRefId: monitorId,
        organizationId,
        projectId,
        monitorType: 'HTTP' as const,
        latency: 20,
        success,
        localSuccess: success,
        checkedAt,
        observationId: randomUUID(),
    });

    /**
     * Independent oracle: buckets the raw `check_logs` rows in JavaScript using
     * the same public definition (LOCAL, evaluated, local date + hour), instead
     * of reusing the SQL the service runs.
     */
    const expectedCells = async (monitorId: string, asOf: Date) => {
        const windowStart = new Date(
            Date.UTC(
                asOf.getUTCFullYear(),
                asOf.getUTCMonth(),
                asOf.getUTCDate() - 2,
            ),
        );
        const rows = await prisma.checkLog.findMany({
            where: {
                monitorId,
                source: 'LOCAL',
                evaluated: true,
                checkedAt: { gte: windowStart, lt: asOf },
            },
            select: { checkedAt: true, success: true },
        });
        const buckets = new Map<
            string,
            { checks: number; successes: number }
        >();
        for (const row of rows) {
            const key = `${row.checkedAt.toISOString().slice(0, 10)}|${row.checkedAt.getUTCHours()}`;
            const bucket = buckets.get(key) ?? { checks: 0, successes: 0 };
            bucket.checks += 1;
            if (row.success) bucket.successes += 1;
            buckets.set(key, bucket);
        }
        const days = [2, 1, 0].map((back) =>
            new Date(
                Date.UTC(
                    asOf.getUTCFullYear(),
                    asOf.getUTCMonth(),
                    asOf.getUTCDate() - back,
                ),
            )
                .toISOString()
                .slice(0, 10),
        );

        return [...buckets.entries()]
            .map(([key, bucket]) => {
                const [day, hour] = key.split('|');
                return [
                    Number(hour),
                    days.indexOf(day),
                    Math.round((bucket.successes / bucket.checks) * 10000) /
                        100,
                ] as [number, number, number];
            })
            .filter((cell) => cell[1] >= 0)
            .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    };

    beforeAll(async () => {
        if (!databaseUrl || !/beacon_dashboard_test/.test(databaseUrl)) {
            throw new Error('Unsafe test database');
        }
        prisma = new PrismaService(
            new ConfigService({
                database: { url: databaseUrl },
                app: { isDevelopment: false },
            }),
        );
        const module = await Test.createTestingModule({
            controllers: [StatusPagesPublicController],
            providers: [
                { provide: PrismaService, useValue: prisma },
                {
                    provide: MultiLevelCacheService,
                    useValue: {
                        getOrSet: async (
                            key: string,
                            build: () => Promise<unknown>,
                        ) => {
                            if (cache.has(key)) return cache.get(key);
                            const value = await build();
                            cache.set(key, value);
                            return value;
                        },
                    } as never,
                },
                StatusPagesService,
                PublicStatusEtagInterceptor,
                {
                    provide: QuotaService,
                    useValue: { assertFeatureAllowed: jest.fn() },
                },
            ],
        }).compile();
        app = module.createNestApplication();
        app.setGlobalPrefix('api');
        app.useGlobalPipes(
            new ValidationPipe({
                whitelist: true,
                forbidNonWhitelisted: false,
                transform: true,
                transformOptions: { enableImplicitConversion: true },
            }),
        );
        app.useGlobalInterceptors(new TransformInterceptor());
        await app.listen(0, '127.0.0.1');
        base = await app.getUrl();

        const user = await prisma.user.create({
            data: {
                email: `${prefix}@test.invalid`,
                name: prefix,
                password: 'unused',
            },
        });
        userId = user.id;
        const organization = await prisma.organization.create({
            data: { name: prefix, slug: prefix, ownerId: user.id },
        });
        organizationId = organization.id;

        slug = `status-page-e2e-${randomUUID().slice(0, 8)}`;
        projectA = (
            await prisma.project.create({
                data: {
                    name: `${prefix}-a`,
                    key: 'A',
                    organizationId,
                },
            })
        ).id;
        projectB = (
            await prisma.project.create({
                data: {
                    name: `${prefix}-b`,
                    key: 'B',
                    organizationId,
                },
            })
        ).id;
        // The project trigger creates one coverage row; make history old enough
        // that the whole 3-day window is covered.
        await prisma.monitoringCoverage.updateMany({
            where: { projectId: { in: [projectA, projectB] } },
            data: {
                checksStartedAt: daysAgo(80),
                countsStartedAt: daysAgo(80),
                probeStartedAt: daysAgo(80),
                alertsStartedAt: daysAgo(80),
            },
        });

        monitorA = (
            await prisma.monitor.create({
                data: {
                    organizationId,
                    projectId: projectA,
                    name: 'Across projects',
                    type: 'HTTP',
                    target: 'https://a.test/health',
                },
            })
        ).id;
        monitorB = (
            await prisma.monitor.create({
                data: {
                    organizationId,
                    projectId: projectB,
                    name: 'Second project',
                    type: 'HTTP',
                    target: 'https://b.test/health',
                },
            })
        ).id;

        await prisma.statusPage.create({
            data: {
                organizationId,
                slug,
                title: prefix,
                visibleMonitorIds: [monitorA, monitorB],
                showLatency: true,
                showUptime: true,
                enabled: true,
            },
        });

        await prisma.checkLog.createMany({
            data: [
                // Yesterday 10:00 UTC: 3 of 4 succeeded.
                ...[true, true, true, false].map((success) =>
                    checkRow(monitorA, projectA, utcHour(1, 10), success),
                ),
                // Yesterday 11:00 UTC: all succeeded.
                ...[true, true].map((success) =>
                    checkRow(monitorA, projectA, utcHour(1, 11), success),
                ),
                // The other project's monitor, same hour, half failed.
                ...[true, false].map((success) =>
                    checkRow(monitorB, projectB, utcHour(1, 10), success),
                ),
            ],
        });
    }, 60000);

    afterAll(async () => {
        if (!prisma) return;
        if (!organizationId) {
            await app?.close();
            await prisma.$disconnect();
            return;
        }
        await prisma.checkLog.deleteMany({ where: { organizationId } });
        await prisma.statusPage.deleteMany({ where: { organizationId } });
        await prisma.monitor.deleteMany({ where: { organizationId } });
        await prisma.monitoringCoverage.deleteMany({
            where: { projectId: { in: [projectA, projectB] } },
        });
        await prisma.project.deleteMany({ where: { organizationId } });
        await prisma.organization.delete({ where: { id: organizationId } });
        await prisma.user.delete({ where: { id: userId } });
        await prisma.$disconnect();
        await app?.close();
    }, 30000);

    it('matches the raw check_logs grid cell by cell', async () => {
        cache.clear();
        const response = await api('?tz=UTC');
        expect(response.status).toBe(200);

        const monitors = response.body.data.monitors;
        expect(monitors).toHaveLength(2);
        const payloads = new Map(
            monitors.map((monitor) => [monitor.id, monitor]),
        );

        for (const id of [monitorA, monitorB]) {
            const availability = payloads.get(id)?.availability;
            expect(availability).toBeDefined();
            expect(availability!.tz).toBe('UTC');
            expect(availability!.days).toHaveLength(3);
            expect(availability!.hours).toEqual(
                Array.from({ length: 24 }, (_, hour) => hour),
            );
            expect(availability!.history.retentionDays).toBe(90);
            expect(availability!.history.status).toBe('AVAILABLE');
            expect(availability!.cells).toEqual(
                await expectedCells(id, new Date(availability!.asOf)),
            );
        }

        expect(payloads.get(monitorA)!.availability!.cells).toEqual([
            [10, 1, 75],
            [11, 1, 100],
        ]);
        expect(payloads.get(monitorB)!.availability!.cells).toEqual([
            [10, 1, 50],
        ]);
        expect(payloads.get(monitorB)!.availability!.worst).toEqual({
            day: payloads.get(monitorB)!.availability!.days[1],
            hour: 10,
            value: 50,
        });
        expect(payloads.get(monitorA)!.availability!.unavailableCells).toEqual(
            [],
        );
    });

    it('truncates only the monitor whose project lacks history', async () => {
        cache.clear();
        await prisma.monitoringCoverage.update({
            where: { projectId: projectB },
            data: { checksStartedAt: now },
        });
        try {
            const response = await api('?tz=UTC');
            const payloads = new Map(
                response.body.data.monitors.map((monitor) => [
                    monitor.id,
                    monitor,
                ]),
            );

            expect(payloads.get(monitorA)!.availability!.history.status).toBe(
                'AVAILABLE',
            );
            const truncated = payloads.get(monitorB)!.availability!;
            expect(truncated.history.status).toBe('TRUNCATED');
            expect(truncated.cells).toEqual([]);
            expect(truncated.worst).toBeNull();
            expect(truncated.unavailableCells.length).toBeGreaterThan(0);
        } finally {
            await prisma.monitoringCoverage.update({
                where: { projectId: projectB },
                data: { checksStartedAt: daysAgo(80) },
            });
            cache.clear();
        }
    });

    it('answers 304 for a matching If-None-Match', async () => {
        cache.clear();
        const first = await api('?tz=Asia/Shanghai');
        expect(first.status).toBe(200);
        const tag = first.headers.get('etag');
        expect(tag).toBeTruthy();
        expect(first.headers.get('cache-control')).toBe('public, no-cache');

        const second = await api('?tz=Asia/Shanghai', {
            'if-none-match': tag!,
        });
        expect(second.status).toBe(304);
        expect(second.text).toBe('');

        const stale = await api('?tz=Asia/Shanghai', {
            'if-none-match': 'W/"stale"',
        });
        expect(stale.status).toBe(200);
        expect(stale.body.data.monitors).toEqual(first.body.data.monitors);
    });

    it('keeps the same time zone out of another zone bucket', async () => {
        cache.clear();
        const utc = await api('?tz=UTC');
        const newYork = await api('?tz=America/New_York');

        expect(newYork.status).toBe(200);
        const utcCells = utc.body.data.monitors.find(
            (monitor) => monitor.id === monitorA,
        )!.availability!.cells;
        const newYorkCells = newYork.body.data.monitors.find(
            (monitor) => monitor.id === monitorA,
        )!.availability!.cells;

        expect(newYorkCells).toEqual(
            await expectedCellsInZone(
                monitorA,
                new Date(
                    newYork.body.data.monitors.find(
                        (monitor) => monitor.id === monitorA,
                    )!.availability!.asOf,
                ),
                'America/New_York',
                newYork.body.data.monitors.find(
                    (monitor) => monitor.id === monitorA,
                )!.availability!.days,
            ),
        );
        expect(newYorkCells).not.toEqual(utcCells);
    });

    it.each([
        ['a fixed-offset time zone', '?tz=%2B08:00'],
        ['an unknown parameter', '?days=3'],
        ['a repeated parameter', '?tz=UTC&tz=UTC'],
        ['an empty parameter', '?tz='],
    ])('rejects %s with 400', async (_name, query) => {
        const response = await api(query);
        expect(response.status).toBe(400);
    });

    it('hides unknown slugs with 404', async () => {
        const response = await fetch(
            `${base}/api/status/unknown-${randomUUID()}`,
        );
        expect(response.status).toBe(404);
    });

    /** Oracle for a non-UTC zone: the zone is resolved by the database itself. */
    async function expectedCellsInZone(
        monitorId: string,
        asOf: Date,
        tz: string,
        days: string[],
    ) {
        const windowStart = new Date(
            Date.UTC(
                asOf.getUTCFullYear(),
                asOf.getUTCMonth(),
                asOf.getUTCDate() - 3,
            ),
        );
        const rows = await prisma.$queryRaw<
            { day: string; hour: number; checks: number; successes: number }[]
        >`
            SELECT to_char("checkedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day,
            extract(hour FROM "checkedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::integer AS hour,
            COUNT(*)::integer AS checks,
            COUNT(*) FILTER (WHERE success)::integer AS successes
            FROM check_logs
            WHERE "monitorId" = ${monitorId} AND source = 'LOCAL' AND evaluated = true
            AND "checkedAt" >= ${windowStart} AND "checkedAt" < ${asOf}
            GROUP BY day, hour`;

        return rows
            .map((row) => {
                const dayIndex = days.indexOf(row.day);
                return [
                    row.hour,
                    dayIndex,
                    Math.round((row.successes / row.checks) * 10000) / 100,
                ] as [number, number, number];
            })
            .filter((cell) => cell[1] >= 0)
            .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    }
});
