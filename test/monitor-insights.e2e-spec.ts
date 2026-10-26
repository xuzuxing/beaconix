import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/infra/database/prisma.service';
import { JwtAuthGuard, OrgMemberGuard } from '../src/common/guards';
import { TransformInterceptor } from '../src/common/interceptors';
import { MonitorInsightsController } from '../src/modules/monitoring/monitor-insights.controller';
import { MonitorInsightsService } from '../src/modules/monitoring/monitor-insights.service';

const url = process.env.MONITORING_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('Monitor insights (real PostgreSQL/HTTP)', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let base: string;
    let org: string;
    let project: string;
    let otherProject: string;
    let user: string;
    let monitor: string;
    let token: string;
    let superToken: string;
    const prefix = `insights-${randomUUID()}`;
    const origin = Date.now();
    const ago = (days: number) => new Date(origin - days * 86400000);
    const request = async (
        query = '',
        jwt = token,
        id = monitor,
        pid = project,
    ) => {
        const response = await fetch(
            `${base}/api/projects/${pid}/monitors/${id}/insights${query}`,
            {
                headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
            },
        );
        return { status: response.status, body: await response.json() };
    };

    beforeAll(async () => {
        if (
            !url ||
            decodeURIComponent(new URL(url).pathname.slice(1)) !==
                'beacon_dashboard_test'
        )
            throw new Error('Unsafe database');
        prisma = new PrismaService(
            new ConfigService({
                database: { url },
                app: { isDevelopment: false },
            }),
        );
        const module = await Test.createTestingModule({
            imports: [JwtModule.register({ secret: 'insights-test-only' })],
            controllers: [MonitorInsightsController],
            providers: [
                { provide: PrismaService, useValue: prisma },
                MonitorInsightsService,
                OrgMemberGuard,
                { provide: APP_GUARD, useClass: JwtAuthGuard },
            ],
        }).compile();
        app = module.createNestApplication();
        app.setGlobalPrefix('api');
        app.useGlobalPipes(
            new ValidationPipe({
                whitelist: true,
                transform: true,
                transformOptions: { enableImplicitConversion: true },
            }),
        );
        app.useGlobalInterceptors(new TransformInterceptor());
        await app.listen(0, '127.0.0.1');
        base = await app.getUrl();
        user = (
            await prisma.user.create({
                data: {
                    email: `${prefix}@test.invalid`,
                    name: prefix,
                    password: 'unused',
                },
            })
        ).id;
        org = (
            await prisma.organization.create({
                data: { name: prefix, slug: prefix, ownerId: user },
            })
        ).id;
        await prisma.membership.create({
            data: { organizationId: org, userId: user, role: 'VIEWER' },
        });
        project = (
            await prisma.project.create({
                data: {
                    organizationId: org,
                    name: prefix,
                    key: 'MAIN',
                    createdAt: ago(80),
                },
            })
        ).id;
        otherProject = (
            await prisma.project.create({
                data: {
                    organizationId: org,
                    name: prefix,
                    key: 'OTHER',
                    createdAt: ago(80),
                },
            })
        ).id;
        await prisma.monitoringCoverage.update({
            where: { projectId: project },
            data: { checksStartedAt: ago(80), alertsStartedAt: ago(80) },
        });
        monitor = (
            await prisma.monitor.create({
                data: {
                    organizationId: org,
                    projectId: project,
                    name: prefix,
                    type: 'HTTP',
                    target: 'https://same.test/health',
                    createdAt: ago(80),
                    state: {
                        create: {
                            status: 'DOWN',
                            failCount: 3,
                            lastLatency: 200,
                        },
                    },
                },
            })
        ).id;
        const other = (
            await prisma.monitor.create({
                data: {
                    organizationId: org,
                    projectId: project,
                    name: 'same-target',
                    type: 'HTTP',
                    target: 'https://same.test/health',
                },
            })
        ).id;
        await prisma.checkLog.createMany({
            data: [
                ...[10, 90, 100, 200].map((latency, i) => ({
                    monitorId: monitor,
                    projectId: project,
                    organizationId: org,
                    monitorType: 'HTTP' as const,
                    latency,
                    success: i !== 3,
                    localSuccess: i < 2,
                    rescuedByProbe: i === 2,
                    checkedAt: new Date(origin - 10000 - i * 1000),
                    observationId: randomUUID(),
                    statusCode: i === 3 ? 500 : 200,
                })),
                {
                    monitorId: monitor,
                    projectId: project,
                    latency: 99999,
                    success: false,
                    source: 'PROBE',
                },
                {
                    monitorId: other,
                    projectId: project,
                    latency: 99999,
                    success: false,
                },
                {
                    monitorId: monitor,
                    projectId: otherProject,
                    latency: 99999,
                    success: false,
                },
            ],
        });
        await prisma.alertEvent.createMany({
            data: [
                {
                    monitorId: monitor,
                    organizationId: org,
                    projectId: project,
                    monitorName: prefix,
                    target: 'https://same.test/health',
                    kind: 'CONNECTIVITY',
                    level: 'critical',
                    reason: 'TIMEOUT',
                    startedAt: ago(40),
                    origin: 'BASELINE',
                    suppressedReason: 'PAUSED',
                },
                {
                    monitorId: monitor,
                    organizationId: org,
                    projectId: project,
                    monitorName: prefix,
                    target: 'https://same.test/health',
                    kind: 'SSL',
                    level: 'warning',
                    reason: 'SSL_EXPIRING',
                    startedAt: new Date(origin - 40000),
                    resolvedAt: new Date(origin - 30000),
                    status: 'resolved',
                    firstNotifiedAt: new Date(origin - 35000),
                    durationSeconds: 10,
                },
                {
                    monitorId: other,
                    organizationId: org,
                    projectId: project,
                    monitorName: 'other',
                    target: 'https://same.test/health',
                    kind: 'CONNECTIVITY',
                    level: 'critical',
                    reason: 'CHECK_FAILED',
                },
            ],
        });
        token = app.get(JwtService).sign({ sub: user, globalRole: 'USER' });
        superToken = app
            .get(JwtService)
            .sign({ sub: user, globalRole: 'SUPER_ADMIN' });
    }, 30000);

    afterAll(async () => {
        if (org) {
            await prisma.alertEvent.deleteMany({
                where: { organizationId: org },
            });
            await prisma.checkLog.deleteMany({
                where: { projectId: { in: [project, otherProject] } },
            });
            await prisma.monitorHistory.deleteMany({
                where: { organizationId: org },
            });
            await prisma.monitor.deleteMany({ where: { organizationId: org } });
            await prisma.organization.delete({ where: { id: org } });
            await prisma.user.delete({ where: { id: user } });
        }
        await app?.close();
        await prisma?.$disconnect();
    });

    it('requires JWT and membership; prevents cross-project and deleted-resource access', async () => {
        expect((await request('', '')).status).toBe(401);
        const outsider = app
            .get(JwtService)
            .sign({ sub: 'outsider', globalRole: 'USER' });
        expect((await request('', outsider)).status).toBe(403);
        expect((await request('', token, monitor, otherProject)).status).toBe(
            404,
        );
        expect((await request('', superToken, 'missing')).status).toBe(404);
        const disposable = await prisma.monitor.create({
            data: {
                organizationId: org,
                projectId: project,
                name: 'deleted',
                type: 'TCP',
                target: 'localhost:8080',
            },
        });
        await prisma.monitor.update({
            where: { id: disposable.id },
            data: { deletedAt: new Date() },
        });
        expect((await request('', superToken, disposable.id)).status).toBe(404);
        await prisma.organization.update({
            where: { id: org },
            data: { deletedAt: new Date() },
        });
        expect((await request('', superToken)).status).toBe(404);
        await prisma.organization.update({
            where: { id: org },
            data: { deletedAt: null },
        });
    });

    it.each([
        '?range=invalid',
        '?range=1h&range=7d',
        '?tz=not-a-zone',
        '?tz=UTC&tz=Asia/Shanghai',
    ])('rejects %s', async (query) => {
        expect((await request(query)).status).toBe(400);
    });

    it.each(['1h', '24h', '7d', '30d'])(
        'uses exact LOCAL window metrics for %s without mixing same-target monitors',
        async (range) => {
            const { status, body } = await request(
                `?range=${range}&tz=America/New_York`,
            );
            expect(status).toBe(200);
            expect(body.meta.timestamp).toBeDefined();
            expect(body.data.metrics).toEqual({
                totalChecks: 4,
                failedChecks: 1,
                rescuedChecks: 1,
                uptimePercent: 75,
                avgLatencyMs: 100,
                p50LatencyMs: 95,
                p95LatencyMs: 185,
                p99LatencyMs: 197,
            });
            expect(body.data.history.status).toBe('AVAILABLE');
            expect(body.data.timeline.points.length).toBeLessThanOrEqual(32);
            expect(
                body.data.timeline.points.reduce(
                    (n: number, p: { checks: number }) => n + p.checks,
                    0,
                ),
            ).toBe(4);
            expect(body.data.checks).toHaveLength(4);
            expect(
                body.data.checks.every(
                    (c: { source: string }) => c.source === 'LOCAL',
                ),
            ).toBe(true);
            // The batch id rides along so the client can open the batch detail.
            expect(
                body.data.checks.every(
                    (c: Record<string, unknown>) => 'roundId' in c,
                ),
            ).toBe(true);
            expect(body.data.events).toHaveLength(2);
            expect(body.data.events[0]).toMatchObject({
                status: 'ongoing',
                origin: 'BASELINE',
                notified: false,
                suppressedReason: 'PAUSED',
            });
            expect(body.data.events[1]).toMatchObject({
                status: 'resolved',
                notified: true,
                durationSeconds: 10,
            });
            expect(body.data.latest.ongoingCount).toBe(1);
            expect(JSON.stringify(body.data)).not.toMatch(
                /latestEvidence|payloadHash|credentialsEnc/,
            );
        },
    );

    it('keeps truncated checks unknown while preserving current state and independent event coverage', async () => {
        await prisma.monitoringCoverage.update({
            where: { projectId: project },
            data: { checksStartedAt: new Date(origin - 60000) },
        });
        const { body } = await request('?range=24h');
        expect(body.data.history).toMatchObject({
            status: 'TRUNCATED',
            alertsStatus: 'AVAILABLE',
        });
        expect(body.data.metrics.totalChecks).toBeNull();
        expect(body.data.metrics.uptimePercent).toBeNull();
        expect(body.data.latest.status).toBe('DOWN');
        expect(
            body.data.timeline.points.some(
                (p: { checks: number | null }) => p.checks === null,
            ),
        ).toBe(true);
        await prisma.monitoringCoverage.update({
            where: { projectId: project },
            data: { checksStartedAt: ago(80) },
        });
    });

    it('returns a known empty baseline for a newly created monitor, never 100 percent uptime', async () => {
        const fresh = await prisma.monitor.create({
            data: {
                projectId: project,
                organizationId: org,
                type: 'TCP',
                name: 'new',
                target: 'localhost:8080',
            },
        });
        const { body } = await request('', token, fresh.id);
        expect(body.data.history.status).toBe('EMPTY');
        expect(body.data.metrics).toMatchObject({
            totalChecks: 0,
            uptimePercent: null,
            avgLatencyMs: null,
        });
        expect(body.data.latest.status).toBe('UNKNOWN');
        expect(body.data.events).toEqual([]);
    });

    it('publishes metric, timeline, check and event schemas', () => {
        const document = SwaggerModule.createDocument(
            app,
            new DocumentBuilder().build(),
        );
        const schema = document.components?.schemas?.MonitorInsightsEntity;
        expect(
            schema && 'properties' in schema && schema.properties?.metrics,
        ).toBeDefined();
    });
});
