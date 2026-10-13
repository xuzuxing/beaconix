import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { PrismaService } from '../src/infra/database/prisma.service';
import { MultiLevelCacheService } from '../src/infra/cache/multi-level-cache.service';
import { JwtAuthGuard, OrgMemberGuard } from '../src/common/guards';
import { TransformInterceptor } from '../src/common/interceptors';
import { MonitoringDashboardController } from '../src/modules/monitoring/monitoring-dashboard.controller';
import { MonitoringDashboardService } from '../src/modules/monitoring/monitoring-dashboard.service';
import { MonitoringEtagInterceptor } from '../src/modules/monitoring/monitoring-etag.interceptor';
import { SystemProbeScheduler } from '../src/modules/admin/system-probes/system-probe-scheduler';
import { AlertEventsService } from '../src/modules/alert-events/alert-events.service';
import type { NotificationsService } from '../src/modules/notifications/notifications.service';
import { StateService } from '../src/modules/state/state.service';
import { NotifierService } from '../src/modules/notifier/notifier.service';
import { AlertOutboxService } from '../src/modules/notifier/alert-outbox.service';
import { ProbesService } from '../src/modules/probes/probes.service';
import { hashSecret } from '../src/modules/probes/probe-secret.util';
import { CheckerService } from '../src/modules/checker/checker.service';
import { MonitorDataCleanupService } from '../src/modules/cron/jobs/monitor-data-cleanup.service';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ProjectAccessService } from '../src/common/authorization/project-access.service';
import { ResourceContextResolver } from '../src/common/authorization/resource-context.resolver';
import { ProjectAccessGuard } from '../src/common/authorization/project-access.guard';
import { systemPrincipal } from '../src/common/authorization/access.types';

// An explicit dedicated database is mandatory. Never default to the developer DB.
const databaseUrl = process.env.MONITORING_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('Monitoring dashboard (PostgreSQL + real HTTP guards)', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let base: string;
    let token: string;
    let adminToken: string;
    let project: string;
    let org: string;
    let user: string;
    let monitor: string;
    let deletedMonitor: string;
    let emptyProject: string;
    let otherProject: string;
    let state: StateService;
    const assigned = new Set<string>();
    const systemProbes: string[] = [];
    const cache = new Map<string, unknown>();
    const prefix = `monitoring-e2e-${randomUUID()}`;
    const origin = Date.now();
    const ago = (days: number) => new Date(origin - days * 86400000);
    const send = jest.fn().mockResolvedValue(undefined);
    const notifications: Pick<
        NotificationsService,
        'publish' | 'organizationRecipients' | 'eventRecipients'
    > = {
        publish: () => Promise.resolve(),
        organizationRecipients: () => Promise.resolve([]),
        eventRecipients: () => Promise.resolve([]),
    };
    const channels: string[] = [];
    const api = async (path: string, jwt = token, headers = {}) => {
        const response = await fetch(`${base}/api/projects/${path}`, {
            headers: { Authorization: `Bearer ${jwt}`, ...headers },
        });
        const text = await response.text();
        return {
            status: response.status,
            headers: response.headers,
            body: text ? JSON.parse(text) : null,
            text,
        };
    };

    beforeAll(async () => {
        if (!databaseUrl || !/beacon_dashboard_test/.test(databaseUrl))
            throw new Error('Unsafe test database');
        prisma = new PrismaService(
            new ConfigService({
                database: { url: databaseUrl },
                app: { isDevelopment: false },
            }),
        );
        const module = await Test.createTestingModule({
            imports: [JwtModule.register({ secret: 'monitoring-test-only' })],
            controllers: [MonitoringDashboardController],
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
                            const result = await build();
                            cache.set(key, result);
                            return result;
                        },
                    },
                },
                {
                    provide: SystemProbeScheduler,
                    useValue: {
                        getAssignmentsForMonitors: () =>
                            Promise.resolve(systemProbes),
                    },
                },
                MonitoringDashboardService,
                MonitoringEtagInterceptor,
                OrgMemberGuard,
                ProjectAccessService,
                ResourceContextResolver,
                ProjectAccessGuard,
                { provide: APP_GUARD, useClass: JwtAuthGuard },
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
        const u = await prisma.user.create({
            data: {
                email: `${prefix}@test.invalid`,
                name: prefix,
                password: 'unused',
            },
        });
        user = u.id;
        const o = await prisma.organization.create({
            data: { name: prefix, slug: prefix, ownerId: user },
        });
        org = o.id;
        await prisma.membership.create({
            data: { userId: user, organizationId: org, role: 'VIEWER' },
        });
        const p = await prisma.project.create({
            data: {
                name: prefix,
                key: 'MAIN',
                organizationId: org,
                createdAt: ago(80),
            },
        });
        project = p.id;
        emptyProject = (
            await prisma.project.create({
                data: {
                    name: prefix,
                    key: 'EMPTY',
                    organizationId: org,
                    createdAt: ago(80),
                },
            })
        ).id;
        otherProject = (
            await prisma.project.create({
                data: {
                    name: prefix,
                    key: 'OTHER',
                    organizationId: org,
                    createdAt: ago(80),
                },
            })
        ).id;
        const membership = await prisma.membership.findUniqueOrThrow({
            where: {
                userId_organizationId: { userId: user, organizationId: org },
            },
        });
        await prisma.projectMembership.createMany({
            data: [project, emptyProject, otherProject].map((projectId) => ({
                projectId,
                organizationId: org,
                membershipId: membership.id,
                role: 'VIEWER' as const,
            })),
        });
        await prisma.monitoringCoverage.updateMany({
            where: { projectId: { in: [project, emptyProject, otherProject] } },
            data: {
                checksStartedAt: ago(80),
                countsStartedAt: ago(80),
                probeStartedAt: ago(80),
                alertsStartedAt: ago(80),
            },
        });
        monitor = (
            await prisma.monitor.create({
                data: {
                    name: 'Current',
                    target: 'https://same.test/health',
                    type: 'HTTP',
                    organizationId: org,
                    projectId: project,
                },
            })
        ).id;
        deletedMonitor = (
            await prisma.monitor.create({
                data: {
                    name: 'Deleted',
                    target: 'https://same.test/health',
                    type: 'HTTP',
                    organizationId: org,
                    projectId: project,
                    deletedAt: ago(1),
                },
            })
        ).id;
        // A mature fixture's baseline is historical evidence, not inferred from current rows.
        await prisma.monitorHistory.updateMany({
            where: { monitorId: { in: [monitor, deletedMonitor] } },
            data: { effectiveAt: ago(80), cause: 'BASELINE' },
        });
        const local = [10, 90, 100, 200].map((latency, i) => ({
            monitorId: i === 3 ? deletedMonitor : monitor,
            monitorRefId: i === 3 ? deletedMonitor : monitor,
            organizationId: org,
            projectId: project,
            monitorType: 'HTTP' as const,
            latency,
            success: i !== 3,
            localSuccess: i !== 3,
            checkedAt: new Date(origin - 100000 - i * 1000),
            statusCode: [200, 302, null, 500][i],
            observationId: randomUUID(),
        }));
        await prisma.checkLog.createMany({
            data: [
                ...local,
                {
                    ...local[0],
                    observationId: randomUUID(),
                    source: 'PROBE',
                    latency: 99999,
                },
                {
                    ...local[0],
                    observationId: randomUUID(),
                    projectId: otherProject,
                    latency: 99999,
                },
                ...[1.5 / 24, 1, 8, 35].map((days) => ({
                    ...local[0],
                    observationId: randomUUID(),
                    checkedAt: ago(days),
                    latency: 50,
                })),
            ],
        });
        const jwt = app.get(JwtService);
        token = jwt.sign({ sub: user, globalRole: 'USER' });
        adminToken = jwt.sign({ sub: user, globalRole: 'SUPER_ADMIN' });
        state = new StateService(
            prisma,
            new AlertEventsService(
                prisma,
                notifications as NotificationsService,
                new ProjectAccessService(prisma),
            ),
            new ProjectAccessService(prisma),
        );
    }, 30000);

    afterAll(async () => {
        if (!prisma) return;
        if (!org) {
            await app?.close();
            await prisma.$disconnect();
            return;
        }
        const ids = [project, emptyProject, otherProject].filter(Boolean);
        await prisma.notificationLog.deleteMany({
            where: {
                monitorId: { in: [monitor, deletedMonitor].filter(Boolean) },
            },
        });
        await prisma.alertDelivery.deleteMany({
            where: { event: { organizationId: org } },
        });
        await prisma.alertEvent.deleteMany({ where: { organizationId: org } });
        await prisma.checkLog.deleteMany({ where: { projectId: { in: ids } } });
        await prisma.probeResult.deleteMany({
            where: { projectId: { in: ids } },
        });
        await prisma.probe.deleteMany({ where: { id: { in: systemProbes } } });
        await prisma.monitorHistory.deleteMany({
            where: { projectId: { in: ids } },
        });
        await prisma.monitoringCoverage.deleteMany({
            where: { projectId: { in: ids } },
        });
        if (org) await prisma.organization.delete({ where: { id: org } });
        if (user) await prisma.user.delete({ where: { id: user } });
        await app?.close();
        await prisma.$disconnect();
    }, 30000);

    it('requires JWT, membership, a live project and live organization even on cache hits', async () => {
        expect((await api(`${project}/monitoring/dashboard`, '')).status).toBe(
            401,
        );
        const stranger = app
            .get(JwtService)
            .sign({ sub: 'not-a-member', globalRole: 'USER' });
        expect(
            (await api(`${project}/monitoring/dashboard`, stranger)).status,
        ).toBe(403);
        expect(
            (await api('missing/monitoring/dashboard', adminToken)).status,
        ).toBe(404);
        await api(`${project}/monitoring/dashboard`);
        await prisma.project.update({
            where: { id: project },
            data: { deletedAt: new Date() },
        });
        expect(
            (await api(`${project}/monitoring/dashboard`, adminToken)).status,
        ).toBe(404);
        await prisma.project.update({
            where: { id: project },
            data: { deletedAt: null },
        });
        await prisma.organization.update({
            where: { id: org },
            data: { deletedAt: new Date() },
        });
        expect(
            (await api(`${project}/monitoring/dashboard`, adminToken)).status,
        ).toBe(404);
        await prisma.organization.update({
            where: { id: org },
            data: { deletedAt: null },
        });
    });

    it.each([
        'range=bogus',
        'slowLimit=6abc',
        'slowLimit=1.2',
        'slowLimit=0',
        'alertLimit=51',
        'slowLimit=1&slowLimit=2',
        'tz=',
        'tz=%2B08:00',
        'tz=Missing/Zone',
        'unexpected=1',
    ])('rejects strict query %s', async (query) => {
        expect(
            (await api(`${project}/monitoring/dashboard?${query}`)).status,
        ).toBe(400);
    });

    it('calculates exact quantiles from LOCAL samples including deleted monitors', async () => {
        cache.clear();
        const response = await api(`${project}/monitoring/dashboard`);
        expect(response.status).toBe(200);
        const d = response.body.data;
        expect(d.kpis).toMatchObject({
            totalChecks: 4,
            failedChecks: 1,
            avgLatencyMs: 100,
            p95LatencyMs: 185,
            uptimePercent: 75,
            failureRatePercent: 25,
            avgLatencyDeltaMs: 50,
        });
        const populated = d.timeline.points.filter(
            (p: { checks: number }) => p.checks > 0,
        );
        expect(
            populated.reduce(
                (n: number, p: { checks: number }) => n + p.checks,
                0,
            ),
        ).toBe(4);
        expect(
            d.distribution.latencyHistogram.buckets.reduce(
                (n: number, b: { count: number }) => n + b.count,
                0,
            ),
        ).toBe(4);
        expect(d.summary.monitors).toMatchObject({ total: 1, unknown: 1 });
        expect(d.slowestMonitors).toHaveLength(1);
        for (const series of Object.values(d.sparklines))
            expect(series).toHaveLength(d.timeline.points.length);
        expect(response.headers.get('etag')).toMatch(/^W\//);
        const again = await api(`${project}/monitoring/dashboard`, token, {
            'If-None-Match': response.headers.get('etag')!,
        });
        expect(again.status).toBe(304);
        expect(again.text).toBe('');
        expect(JSON.stringify(d)).not.toMatch(
            /secret|callbackUrl|NaN|Infinity/,
        );
    });

    it.each(['today', '7d', '30d'])(
        'computes mature %s comparisons',
        async (range) => {
            const response = await api(
                `${project}/monitoring/dashboard?range=${range}`,
            );
            expect(response.status).toBe(200);
            expect(response.body.data.history.previous).toBe('AVAILABLE');
            expect(response.body.data.kpis.avgLatencyDeltaMs).not.toBeNull();
        },
    );

    it('distinguishes known empty and genuinely truncated history', async () => {
        const empty = (await api(`${emptyProject}/monitoring/dashboard`)).body
            .data;
        expect(empty.kpis).toMatchObject({
            totalChecks: 0,
            avgLatencyMs: null,
            monitorCount: 0,
            monitorDelta: 0,
        });
        expect(empty.timeline.points).toEqual([]);
        await prisma.monitoringCoverage.update({
            where: { projectId: project },
            data: { checksStartedAt: new Date() },
        });
        cache.clear();
        const d = (await api(`${project}/monitoring/dashboard`)).body.data;
        expect(d.history.current).toBe('TRUNCATED');
        expect(d.kpis.totalChecks).toBeNull();
        expect(d.kpis.monitorCount).toBe(1);
        expect(d.distribution.latencyHistogram.buckets).toEqual([]);
        await prisma.monitoringCoverage.update({
            where: { projectId: project },
            data: { checksStartedAt: ago(80) },
        });
        cache.clear();
    });

    it('returns heatmap and conservative HTTP partitions', async () => {
        const availability = await api(
            `${project}/monitoring/availability?days=30&tz=America/New_York`,
        );
        expect(availability.status).toBe(200);
        expect(availability.body.data.days).toHaveLength(30);
        expect(availability.body.data.cells.length).toBeGreaterThan(0);
        const codes = await api(
            `${project}/monitoring/status-codes?hours=12&tz=Asia/Kolkata`,
        );
        expect(codes.status).toBe(200);
        for (const b of codes.body.data.buckets)
            expect(b.httpChecks).toBe(
                b.success2xx +
                    b.redirect3xx +
                    b.clientError4xx +
                    b.serverError5xx +
                    b.otherStatusCode +
                    b.noStatusCode,
            );
        expect(
            codes.body.data.buckets.some(
                (b: { noStatusCode: number }) => b.noStatusCode === 1,
            ),
        ).toBe(true);
    });

    it('atomically records history and suppresses rather than recovers after configuration changes', async () => {
        await prisma.monitor.update({
            where: { id: monitor },
            data: { failureThreshold: 1, checkSsl: true },
        });
        await state.record(monitor, {
            success: true,
            latency: 10,
            serviceVerdict: 'SUCCESS',
        });
        await state.record(monitor, {
            success: false,
            latency: 30,
            serviceVerdict: 'SUCCESS',
            sslVerdict: 'EXPIRING',
        });
        const ssl = await prisma.alertEvent.findFirstOrThrow({
            where: { monitorId: monitor, kind: 'SSL', status: 'ongoing' },
        });
        await prisma.monitor.update({
            where: { id: monitor },
            data: { checkSsl: false },
        });
        expect(
            (
                await prisma.alertEvent.findUniqueOrThrow({
                    where: { id: ssl.id },
                })
            ).suppressedReason,
        ).toBe('CONFIG_DISABLED');
        expect(
            (
                await prisma.alertEvent.findUniqueOrThrow({
                    where: { id: ssl.id },
                })
            ).resolvedAt,
        ).toBeNull();
        const revision = (
            await prisma.monitor.findUniqueOrThrow({ where: { id: monitor } })
        ).configRevision;
        await expect(
            state.record(monitor, {
                success: true,
                latency: 10,
                configRevision: revision - 1,
            }),
        ).rejects.toThrow('configuration changed');
        await prisma.monitor.update({
            where: { id: monitor },
            data: { enabled: false },
        });
        const last = await prisma.monitorHistory.findFirstOrThrow({
            where: { monitorId: monitor },
            orderBy: { revision: 'desc' },
        });
        expect(last.status).toBe('PAUSED');
        await prisma.monitor.update({
            where: { id: monitor },
            data: { enabled: true, checkSsl: true },
        });
        await state.record(monitor, {
            success: true,
            latency: 10,
            sslVerdict: 'VALID',
            serviceVerdict: 'SUCCESS',
        });
        expect(
            (
                await prisma.alertEvent.findUniqueOrThrow({
                    where: { id: ssl.id },
                })
            ).status,
        ).toBe('resolved');
    });

    it('durably retries enqueue failure and records actual successful delivery only once', async () => {
        const channel = await prisma.notificationChannel.create({
            data: {
                organizationId: org,
                name: prefix,
                type: 'EMAIL',
                config: { to: ['nobody@test.invalid'] },
            },
        });
        channels.push(channel.id);
        await state.record(monitor, {
            success: false,
            latency: 100,
            serviceVerdict: 'FAILURE',
            failureReason: 'TIMEOUT',
        });
        const event = await prisma.alertEvent.findFirstOrThrow({
            where: {
                monitorId: monitor,
                kind: 'CONNECTIVITY',
                status: 'ongoing',
            },
        });
        expect(event.firstNotifiedAt).toBeNull();
        const delivery = await prisma.alertDelivery.findFirstOrThrow({
            where: { eventId: event.id },
        });
        const queue = {
            add: jest
                .fn()
                .mockRejectedValueOnce(new Error('Redis unavailable'))
                .mockResolvedValue({}),
        };
        const outbox = new AlertOutboxService(
            prisma,
            { register: jest.fn() } as never,
            queue as never,
        );
        await outbox.dispatch();
        expect(
            (
                await prisma.alertDelivery.findUniqueOrThrow({
                    where: { id: delivery.id },
                })
            ).status,
        ).toBe('PENDING');
        await prisma.alertDelivery.update({
            where: { id: delivery.id },
            data: { nextAttemptAt: new Date(0) },
        });
        await outbox.dispatch();
        const notifier = new NotifierService(
            prisma,
            { send } as never,
            { send } as never,
            { send } as never,
            { send } as never,
            { send } as never,
            queue as never,
        );
        await notifier.deliverAlertDelivery(delivery.id);
        await notifier.deliverAlertDelivery(delivery.id);
        expect(send).toHaveBeenCalledTimes(1);
        expect(
            (
                await prisma.alertEvent.findUniqueOrThrow({
                    where: { id: event.id },
                })
            ).firstNotifiedAt,
        ).not.toBeNull();
        await prisma.notificationChannel.delete({ where: { id: channel.id } });
        expect(
            await prisma.notificationLog.count({
                where: { deliveryId: delivery.id, status: 'SUCCESS' },
            }),
        ).toBe(1);
    });

    it('publishes nested Swagger schemas through the public package API', () => {
        const document = SwaggerModule.createDocument(
            app,
            new DocumentBuilder().build(),
        );
        const schema = document.components!.schemas!
            .MonitoringDashboardEntity as {
            properties: Record<string, { properties: Record<string, unknown> }>;
        };
        expect(schema.properties.kpis.properties).toHaveProperty(
            'p95LatencyDeltaMs',
        );
        expect(schema.properties.summary.properties).toHaveProperty(
            'expiringCertificates',
        );
    });

    it.each(['TENANT', 'SYSTEM'] as const)(
        'isolates %s duplicate targets and durably deduplicates reports',
        async (scope) => {
            const raw = `${prefix}-${scope}`;
            const probe = await prisma.probe.create({
                data: {
                    name: raw,
                    scope,
                    organizationId: scope === 'TENANT' ? org : null,
                    provider: 'CUSTOM',
                    region: 'unknown-region',
                    callbackUrl: 'https://internal.test/private',
                    status: 'ONLINE',
                    secrets: {
                        create: {
                            secretHash: hashSecret(raw),
                            secretPrefix: raw.slice(0, 8),
                        },
                    },
                },
            });
            if (scope === 'SYSTEM') systemProbes.push(probe.id);
            const second = await prisma.monitor.create({
                data: {
                    name: 'Other project same target',
                    target: 'https://same.test/health',
                    type: 'HTTP',
                    organizationId: org,
                    projectId: otherProject,
                },
            });
            if (scope === 'TENANT')
                await prisma.monitorProbe.createMany({
                    data: [monitor, second.id].map((monitorId) => ({
                        monitorId,
                        probeId: probe.id,
                    })),
                });
            assigned.add(monitor);
            assigned.add(second.id);
            const checker = {
                ingestProbeReportForMonitor: jest
                    .fn()
                    .mockImplementation(async (monitorId, report) => {
                        const result = await state.record(monitorId, {
                            ...report,
                            success: report.success,
                            source: 'PROBE',
                            latency: report.latency,
                            serviceVerdict: report.success
                                ? 'SUCCESS'
                                : 'FAILURE',
                        });
                        if (!result) return null;
                        return {
                            monitorId,
                            status: result.transition.status,
                            changed: result.transition.changed,
                        };
                    }),
            };
            const service = new ProbesService(
                prisma,
                checker as unknown as CheckerService,
                {
                    getAssignedMonitorIds: () => Promise.resolve([...assigned]),
                } as never,
                {} as never,
                {} as never,
                { register: jest.fn() } as never,
                notifications as NotificationsService,
            );
            const current = await prisma.monitor.findUniqueOrThrow({
                where: { id: monitor },
            });
            const report = {
                monitorId: monitor,
                reportId: randomUUID(),
                configRevision: current.configRevision,
                target: current.target,
                checkedAt: new Date().toISOString(),
                success: true,
                latency: 24,
                statusCode: 200,
            };
            const another = {
                ...report,
                monitorId: second.id,
                reportId: randomUUID(),
                configRevision: second.configRevision,
                latency: 90,
            };
            await service.recordResults(raw, [report, another]);
            const stored = await prisma.probeResult.findMany({
                where: { probeId: probe.id },
            });
            expect(stored).toHaveLength(2);
            expect(stored.find((r) => r.monitorId === monitor)?.projectId).toBe(
                project,
            );
            expect(
                stored.find((r) => r.monitorId === second.id)?.projectId,
            ).toBe(otherProject);
            expect(stored.every((r) => r.appliedAt)).toBe(true);
            const count = await prisma.checkLog.count({
                where: {
                    observationId: `probe:${probe.id}:${report.reportId}`,
                },
            });
            await service.recordResults(raw, [report]);
            expect(
                await prisma.checkLog.count({
                    where: {
                        observationId: `probe:${probe.id}:${report.reportId}`,
                    },
                }),
            ).toBe(count);
            await expect(
                service.recordResults(raw, [{ ...report, latency: 999 }]),
            ).rejects.toThrow('reportId');
            await expect(
                service.recordResults(raw, [
                    {
                        ...report,
                        reportId: randomUUID(),
                        monitorId: randomUUID(),
                    },
                ]),
            ).rejects.toThrow('assigned');
            await expect(
                service.recordResults(raw, [
                    { ...report, reportId: randomUUID(), monitorId: undefined },
                ]),
            ).rejects.toThrow('uniquely');
            await prisma.monitor.update({
                where: { id: monitor },
                data: { timeout: current.timeout + 1 },
            });
            // A retry is the original observation, not an observation under the new config.
            await expect(
                service.recordResults(raw, [report]),
            ).resolves.toMatchObject({ applied: 0 });
            await expect(
                service.recordResults(raw, [
                    { ...report, reportId: randomUUID() },
                ]),
            ).rejects.toThrow('configuration changed');
            const refreshed = await prisma.monitor.findUniqueOrThrow({
                where: { id: monitor },
            });
            const pending = {
                ...report,
                configRevision: refreshed.configRevision,
                reportId: randomUUID(),
                checkedAt: new Date().toISOString(),
            };
            checker.ingestProbeReportForMonitor.mockRejectedValueOnce(
                new Error('process interrupted'),
            );
            await expect(service.recordResults(raw, [pending])).rejects.toThrow(
                'interrupted',
            );
            expect(
                (
                    await prisma.probeResult.findUniqueOrThrow({
                        where: {
                            probeId_reportId: {
                                probeId: probe.id,
                                reportId: pending.reportId,
                            },
                        },
                    })
                ).appliedAt,
            ).toBeNull();
            await service.applyPendingResults();
            expect(
                (
                    await prisma.probeResult.findUniqueOrThrow({
                        where: {
                            probeId_reportId: {
                                probeId: probe.id,
                                reportId: pending.reportId,
                            },
                        },
                    })
                ).appliedAt,
            ).not.toBeNull();
            cache.clear();
            const dashboard = (await api(`${project}/monitoring/dashboard`))
                .body.data;
            const safe = dashboard.distribution.probes.find(
                (p: { id: string }) => p.id === probe.id,
            );
            expect(safe.latencyMs).toBe(24);
            expect(Object.keys(safe).sort()).toEqual([
                'enabled',
                'id',
                'latencyMs',
                'name',
                'online',
                'region',
                'scope',
            ]);
            if (scope === 'SYSTEM')
                expect(safe.name).toBe('System (unknown-region)');
        },
    );

    it('retries real delivery failures to a terminal state and requires controlled retry', async () => {
        const channel = await prisma.notificationChannel.create({
            data: {
                organizationId: org,
                name: `${prefix}-fail`,
                type: 'EMAIL',
                config: { to: ['nobody@test.invalid'] },
            },
        });
        await state.record(monitor, {
            success: true,
            latency: 10,
            serviceVerdict: 'SUCCESS',
        });
        await state.record(monitor, {
            success: false,
            latency: 100,
            serviceVerdict: 'FAILURE',
        });
        const event = await prisma.alertEvent.findFirstOrThrow({
            where: {
                monitorId: monitor,
                kind: 'CONNECTIVITY',
                status: 'ongoing',
            },
        });
        const delivery = await prisma.alertDelivery.findFirstOrThrow({
            where: { eventId: event.id, channelId: channel.id, phase: 'OPEN' },
        });
        const failing = jest
            .fn()
            .mockRejectedValue(new Error('provider unavailable'));
        const notifier = new NotifierService(
            prisma,
            { send: failing } as never,
            { send: failing } as never,
            { send: failing } as never,
            { send: failing } as never,
            { send: failing } as never,
            {} as never,
        );
        for (let attempt = 0; attempt < 3; attempt++) {
            await prisma.alertDelivery.update({
                where: { id: delivery.id },
                data: { nextAttemptAt: new Date(0) },
            });
            await expect(
                notifier.deliverAlertDelivery(delivery.id),
            ).rejects.toThrow('provider unavailable');
        }
        expect(
            (
                await prisma.alertDelivery.findUniqueOrThrow({
                    where: { id: delivery.id },
                })
            ).status,
        ).toBe('FAILED');
        expect(
            (
                await prisma.alertEvent.findUniqueOrThrow({
                    where: { id: event.id },
                })
            ).firstNotifiedAt,
        ).toBeNull();
        await notifier.deliverAlertDelivery(delivery.id);
        expect(failing).toHaveBeenCalledTimes(3);
        await expect(
            new AlertEventsService(
                prisma,
                notifications as NotificationsService,
                new ProjectAccessService(prisma),
            ).retry(
                otherProject,
                delivery.id,
                systemPrincipal('alert integration fixture'),
            ),
        ).rejects.toThrow();
        await new AlertEventsService(
            prisma,
            notifications as NotificationsService,
            new ProjectAccessService(prisma),
        ).retry(
            project,
            delivery.id,
            systemPrincipal('alert integration fixture'),
        );
        expect(
            (
                await prisma.alertDelivery.findUniqueOrThrow({
                    where: { id: delivery.id },
                })
            ).status,
        ).toBe('PENDING');
        await prisma.notificationChannel.delete({ where: { id: channel.id } });
    });

    it('retains recovery intent while the opening delivery is in flight', async () => {
        const channel = await prisma.notificationChannel.create({
            data: {
                organizationId: org,
                name: `${prefix}-race`,
                type: 'EMAIL',
                config: { to: ['nobody@test.invalid'] },
            },
        });
        await state.record(monitor, {
            success: true,
            latency: 10,
            serviceVerdict: 'SUCCESS',
        });
        await state.record(monitor, {
            success: false,
            latency: 100,
            serviceVerdict: 'FAILURE',
        });
        const event = await prisma.alertEvent.findFirstOrThrow({
            where: {
                monitorId: monitor,
                kind: 'CONNECTIVITY',
                status: 'ongoing',
            },
        });
        const opening = await prisma.alertDelivery.findFirstOrThrow({
            where: { eventId: event.id, channelId: channel.id, phase: 'OPEN' },
        });
        let release!: () => void;
        let started!: () => void;
        const begun = new Promise<void>((resolve) => {
            started = resolve;
        });
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const sender = jest
            .fn()
            .mockImplementationOnce(async () => {
                started();
                await held;
            })
            .mockResolvedValue(undefined);
        const notifier = new NotifierService(
            prisma,
            { send: sender } as never,
            { send: sender } as never,
            { send: sender } as never,
            { send: sender } as never,
            { send: sender } as never,
            {} as never,
        );
        const sending = notifier.deliverAlertDelivery(opening.id);
        await begun;
        try {
            await state.record(monitor, {
                success: true,
                latency: 10,
                serviceVerdict: 'SUCCESS',
            });
            const recovery = await prisma.alertDelivery.findFirstOrThrow({
                where: {
                    eventId: event.id,
                    channelId: channel.id,
                    phase: 'RECOVERY',
                },
            });
            await notifier.deliverAlertDelivery(recovery.id);
            expect(
                (
                    await prisma.alertDelivery.findUniqueOrThrow({
                        where: { id: recovery.id },
                    })
                ).status,
            ).toBe('PENDING');
            release();
            await sending;
            await prisma.alertDelivery.update({
                where: { id: recovery.id },
                data: { nextAttemptAt: new Date(0) },
            });
            await notifier.deliverAlertDelivery(recovery.id);
            expect(sender).toHaveBeenCalledTimes(2);
            expect(
                (
                    await prisma.alertDelivery.findUniqueOrThrow({
                        where: { id: recovery.id },
                    })
                ).status,
            ).toBe('SUCCESS');
        } finally {
            release();
            await sending;
        }
        await prisma.notificationChannel.delete({ where: { id: channel.id } });
    });

    it('keeps the last pre-retention count anchor while removing older history', async () => {
        const old = await prisma.monitor.create({
            data: {
                name: 'Anchor fixture',
                target: 'https://anchor.test',
                type: 'HTTP',
                organizationId: org,
                projectId: otherProject,
            },
        });
        await prisma.monitorHistory.deleteMany({
            where: { monitorId: old.id },
        });
        await prisma.monitorHistory.createMany({
            data: [110, 100, 95, 5].map((days, i) => ({
                monitorId: old.id,
                organizationId: org,
                projectId: otherProject,
                enabled: true,
                deleted: false,
                status: 'UP',
                revision: i + 1,
                cause: 'STATE',
                effectiveAt: ago(days),
            })),
        });
        await new MonitorDataCleanupService(
            prisma,
            {} as never,
        ).handleCleanup();
        expect(
            (
                await prisma.monitorHistory.findMany({
                    where: { monitorId: old.id },
                    orderBy: { revision: 'asc' },
                })
            ).map((h) => h.revision),
        ).toEqual([3, 4]);
    });

    it('records representative SQL plans, bounded response size and cold/hot timings', async () => {
        await prisma.$executeRaw`
            INSERT INTO check_logs (id,"monitorId","monitorRefId","organizationId","projectId","monitorType",
                success,"localSuccess",latency,source,"checkedAt","observationId","ruleGroupIds")
            SELECT ${prefix} || ':perf:' || g, ${monitor}, ${monitor}, ${org}, ${project}, 'HTTP'::"MonitorType",
                (g % 20 <> 0), (g % 20 <> 0), 10 + (g % 1000), 'LOCAL'::"CheckSource",
                (NOW() AT TIME ZONE 'UTC') - (g * INTERVAL '80 seconds'), ${prefix} || ':perf:' || g, ARRAY[]::text[]
            FROM generate_series(1, 60000) g`;
        await prisma.$executeRaw`ANALYZE check_logs`;
        const from = ago(30);
        const plan = await prisma.$queryRaw`
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT count(*), avg(latency), percentile_cont(0.95) WITHIN GROUP (ORDER BY latency)
            FROM check_logs WHERE "projectId" = ${project} AND source = 'LOCAL'
                AND "checkedAt" >= ${from} AND "checkedAt" < ${new Date()}`;
        cache.clear();
        let start = performance.now();
        const cold = await api(`${project}/monitoring/dashboard?range=30d`);
        const coldMs = performance.now() - start;
        start = performance.now();
        const hot = await api(`${project}/monitoring/dashboard?range=30d`);
        const hotMs = performance.now() - start;
        expect(cold.status).toBe(200);
        expect(hot.body.data.asOf).toBe(cold.body.data.asOf);
        expect(cold.body.data.timeline.points.length).toBeLessThanOrEqual(31);
        const record = {
            date: new Date().toISOString(),
            seededRows: 60000,
            totalRows: await prisma.checkLog.count({
                where: { projectId: project },
            }),
            coldMs,
            hotMs,
            bytes: Buffer.byteLength(cold.text),
            cache: 'test in-memory cache; real authorization/SQL/HTTP',
            points: cold.body.data.timeline.points.length,
            plan,
        };
        await mkdir('plans/monitoring-overview/artifacts', { recursive: true });
        await writeFile(
            'plans/monitoring-overview/artifacts/performance.json',
            JSON.stringify(record, null, 2),
        );
        console.log(
            'Monitoring performance:',
            JSON.stringify({ ...record, plan: 'See performance.json' }),
        );
    }, 30000);

    it('accepts the first successful observation from a returning offline probe', async () => {
        const m = await prisma.monitor.create({
            data: {
                name: 'Offline recovery',
                type: 'HTTP',
                target: 'https://return.test',
                organizationId: org,
                projectId: otherProject,
                failureThreshold: 1,
            },
        });
        await state.record(m.id, {
            success: true,
            latency: 10,
            serviceVerdict: 'SUCCESS',
            checkedAt: new Date(Date.now() - 2000),
        });
        await state.record(m.id, {
            success: false,
            latency: 10,
            serviceVerdict: 'FAILURE',
            localServiceVerdict: 'FAILURE',
            configRevision: m.configRevision,
            checkedAt: new Date(Date.now() - 1000),
        });
        const raw = `${prefix}-offline`;
        const probe = await prisma.probe.create({
            data: {
                name: raw,
                scope: 'TENANT',
                organizationId: org,
                provider: 'CUSTOM',
                region: 'test',
                callbackUrl: 'https://internal.test',
                status: 'OFFLINE',
                monitors: { create: { monitorId: m.id } },
                secrets: {
                    create: {
                        secretHash: hashSecret(raw),
                        secretPrefix: raw.slice(0, 8),
                    },
                },
            },
        });
        const scheduler = { getAssignedProbes: () => Promise.resolve([]) };
        const checker = new CheckerService(
            prisma,
            state,
            {} as never,
            {} as never,
            {} as never,
            scheduler as never,
            {} as never,
            { findBindingsForMonitor: () => Promise.resolve([]) } as never,
            new ProjectAccessService(prisma),
        );
        const probes = new ProbesService(
            prisma,
            checker,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            notifications as NotificationsService,
        );
        await probes.recordResults(raw, [
            {
                monitorId: m.id,
                target: m.target,
                success: true,
                latency: 25,
                checkedAt: new Date().toISOString(),
                configRevision: m.configRevision,
                reportId: randomUUID(),
            },
        ]);
        expect(
            (await prisma.probe.findUniqueOrThrow({ where: { id: probe.id } }))
                .status,
        ).toBe('ONLINE');
        expect(
            (
                await prisma.monitorState.findUniqueOrThrow({
                    where: { monitorId: m.id },
                })
            ).status,
        ).toBe('UP');
        expect(
            (
                await prisma.alertEvent.findFirstOrThrow({
                    where: { monitorId: m.id },
                })
            ).status,
        ).toBe('resolved');
    });

    it('creates recovery after pause/resume only for an actual prior opening', async () => {
        const m = await prisma.monitor.create({
            data: {
                name: 'Pause recovery',
                type: 'HTTP',
                target: 'https://pause.test',
                organizationId: org,
                projectId: otherProject,
                failureThreshold: 1,
            },
        });
        const channel = await prisma.notificationChannel.create({
            data: {
                organizationId: org,
                name: `${prefix}-resume`,
                type: 'EMAIL',
                config: { to: ['nobody@test.invalid'] },
            },
        });
        await state.record(m.id, {
            success: true,
            latency: 10,
            serviceVerdict: 'SUCCESS',
        });
        await state.record(m.id, {
            success: false,
            latency: 10,
            serviceVerdict: 'FAILURE',
        });
        const event = await prisma.alertEvent.findFirstOrThrow({
            where: { monitorId: m.id, status: 'ongoing' },
        });
        const opening = await prisma.alertDelivery.findFirstOrThrow({
            where: { eventId: event.id, channelId: channel.id },
        });
        const sender = { send: jest.fn().mockResolvedValue(undefined) };
        const notifier = new NotifierService(
            prisma,
            sender as never,
            sender as never,
            sender as never,
            sender as never,
            sender as never,
            {} as never,
        );
        await notifier.deliverAlertDelivery(opening.id);
        await prisma.monitor.update({
            where: { id: m.id },
            data: { enabled: false, state: { update: { status: 'PAUSED' } } },
        });
        expect(
            await prisma.alertDelivery.count({
                where: { eventId: event.id, phase: 'RECOVERY' },
            }),
        ).toBe(0);
        await prisma.monitor.update({
            where: { id: m.id },
            data: { enabled: true, state: { update: { status: 'UNKNOWN' } } },
        });
        await state.record(m.id, {
            success: true,
            latency: 10,
            serviceVerdict: 'SUCCESS',
        });
        const recovery = await prisma.alertDelivery.findFirstOrThrow({
            where: { eventId: event.id, phase: 'RECOVERY' },
        });
        await notifier.deliverAlertDelivery(recovery.id);
        expect(sender.send).toHaveBeenCalledTimes(2);
        await prisma.notificationChannel.delete({ where: { id: channel.id } });
    });
});
