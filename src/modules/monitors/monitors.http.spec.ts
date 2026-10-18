import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../../infra/database/prisma.service';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { GlobalExceptionFilter } from '../../common/filters/global-exception.filter';
import { QuotaService } from '../../shared/quota/quota.service';
import { SystemProbeScheduler } from '../admin/system-probes/system-probe-scheduler';
import { NotifierService } from '../notifier/notifier.service';
import { MonitorsController } from './monitors.controller';
import { MonitorsService } from './monitors.service';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { MonitorSecurityModule } from './monitor-security.module';
import { ConfigService } from '@nestjs/config';
import { ProjectAccessService } from '../../common/authorization/project-access.service';
import { ResourceContextResolver } from '../../common/authorization/resource-context.resolver';
import { ProjectAccessGuard } from '../../common/authorization/project-access.guard';

/** Real HTTP/DTO/tenant guards with isolated persistence; no external DB or JWT service. */
describe('Monitor HTTP integration', () => {
    let app: INestApplication;
    const prisma = {
        user: { findFirst: jest.fn() },
        project: { findFirst: jest.fn() },
        organization: { findFirst: jest.fn() },
        membership: {
            findUnique: jest.fn(),
            findMany: jest.fn().mockResolvedValue([{ id: 'membership' }]),
        },
        projectMembership: { findUnique: jest.fn().mockResolvedValue(null) },
        monitor: {
            create: jest.fn(),
            findFirst: jest.fn(),
            findFirstOrThrow: jest.fn(),
            update: jest.fn(),
        },
        probe: { count: jest.fn().mockResolvedValue(0) },
        monitorProbe: { createMany: jest.fn(), deleteMany: jest.fn() },
        $queryRaw: jest.fn().mockResolvedValue([]),
        $transaction: jest.fn(),
    };
    const quota = {
        assertCanCreate: jest.fn(),
        assertIntervalAllowed: jest.fn(),
        assertMonitorTypeAllowed: jest.fn(),
        assertProbesAssignable: jest.fn(),
        getProbeAssignmentLimit: jest.fn().mockResolvedValue(10),
        getMonitorPolicy: jest.fn().mockResolvedValue({
            allowedMonitorTypes: ['HTTP', 'TCP', 'PING', 'DNS'],
            minInterval: 10,
            maxProbes: 10,
            maxProbesPerMonitor: 10,
        }),
        monitorEligibility: jest.fn(),
    };

    beforeAll(async () => {
        prisma.$transaction.mockImplementation((work) => work(prisma));
        const module = await Test.createTestingModule({
            imports: [MonitorSecurityModule],
            controllers: [MonitorsController],
            providers: [
                MonitorsService,
                ProjectAccessService,
                ResourceContextResolver,
                ProjectAccessGuard,
                { provide: PrismaService, useValue: prisma },
                { provide: QuotaService, useValue: quota },
                {
                    provide: SystemProbeScheduler,
                    useValue: { rebalance: jest.fn() },
                },
                { provide: NotifierService, useValue: {} },
            ],
        })
            .overrideProvider(ConfigService)
            .useValue(
                new ConfigService({
                    monitor: {
                        secretKey: Buffer.alloc(32, 7).toString('base64'),
                    },
                }),
            )
            .compile();
        app = module.createNestApplication();
        app.setGlobalPrefix('api');
        app.use((req, _res, next) => {
            req.user = { sub: 'user-1', globalRole: 'USER' };
            next();
        });
        app.useGlobalPipes(
            new ValidationPipe({
                whitelist: true,
                forbidNonWhitelisted: true,
                transform: true,
                transformOptions: {
                    enableImplicitConversion: true,
                },
            }),
        );
        app.useGlobalInterceptors(new TransformInterceptor());
        app.useGlobalFilters(new GlobalExceptionFilter());
        await app.init();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        prisma.user.findFirst.mockResolvedValue({ globalRole: 'USER' });
        prisma.project.findFirst.mockResolvedValue({
            id: 'project-1',
            organizationId: 'org-1',
            status: 'ACTIVE',
        });
        prisma.organization.findFirst.mockResolvedValue({ id: 'org-1' });
        prisma.membership.findUnique.mockResolvedValue({
            id: 'membership',
            role: 'ADMIN',
        });
        quota.monitorEligibility.mockResolvedValue({
            eligible: true,
            reason: null,
        });
        prisma.monitor.create.mockImplementation(({ data }) => ({
            ...data,
            id: 'monitor-1',
            enabled: true,
            interval: 60,
            configVersion: 1,
            revision: 1,
            // The database default, which the mock has to restate.
            probeSuccessRatio: data.probeSuccessRatio ?? 1,
            state: null,
        }));
    });
    afterAll(async () => app.close());

    it('rejects a no-longer-active user through the real tenant guard', async () => {
        prisma.user.findFirst.mockResolvedValue(null);
        await request(app.getHttpServer())
            .post('/api/projects/project-1/monitors')
            .send({ name: 'DNS', type: 'DNS', target: 'example.com' })
            .expect(401);
        expect(prisma.monitor.create).not.toHaveBeenCalled();
    });

    it.each([
        [
            'MYSQL',
            'db.example.com:3306',
            {
                username: 'monitor',
                password: 'private-password',
                database: 'health',
            },
        ],
        [
            'POSTGRESQL',
            'db.example.com:5432',
            {
                username: 'monitor',
                password: 'private-password',
                database: 'health',
            },
        ],
        ['REDIS', 'cache.example.com:6379', { password: 'private-password' }],
        [
            'MONGODB',
            'db.example.com:27017',
            { username: 'monitor', password: 'private-password' },
        ],
        [
            'DOCKER',
            'https://docker.example.com:2376',
            { containerId: 'api', token: 'private-password' },
        ],
        [
            'GRPC',
            'grpc.example.com:50051',
            { service: 'example.Service', token: 'private-password' },
        ],
        [
            'WEBSOCKET',
            'wss://ws.example.com/health',
            { token: 'private-password' },
        ],
    ])(
        'creates %s with encrypted write-only credentials through HTTP',
        async (type, target, config) => {
            const response = await request(app.getHttpServer())
                .post('/api/projects/project-1/monitors')
                .send({ name: type, type, target, config })
                .expect(201);
            expect(response.body.data).toMatchObject({
                type,
                target,
                timeout: 10000,
                hasCredentials: true,
            });
            expect(response.body.data).not.toHaveProperty('credentialsEnc');
            expect(JSON.stringify(response.body)).not.toContain(
                'private-password',
            );
            const data = prisma.monitor.create.mock.calls[0][0].data;
            expect(data.credentialsEnc).toMatch(/^v1:/);
            expect(JSON.stringify(data)).not.toContain('private-password');
        },
    );

    it('rejects credentials embedded in application URLs without persisting them', async () => {
        await request(app.getHttpServer())
            .post('/api/projects/project-1/monitors')
            .send({
                name: 'WS',
                type: 'WEBSOCKET',
                target: 'wss://user:secret@ws.example.com',
                config: {},
            })
            .expect(400);
        expect(prisma.monitor.create).not.toHaveBeenCalled();
    });

    it('creates DNS with normalized config through the existing response envelope', async () => {
        const response = await request(app.getHttpServer())
            .post('/api/projects/project-1/monitors')
            .send({
                name: 'DNS',
                type: 'DNS',
                target: 'example.com',
                config: {
                    recordType: 'CNAME',
                    expectedValues: ['WWW.Example.COM.'],
                },
            })
            .expect(201);
        expect(response.body.data).toMatchObject({
            type: 'DNS',
            config: {
                recordType: 'CNAME',
                expectedValues: ['www.example.com'],
            },
            configVersion: 1,
            revision: 1,
            organizationId: 'org-1',
        });
        expect(response.body.meta.timestamp).toBeDefined();
        expect(quota.assertMonitorTypeAllowed).toHaveBeenCalledWith(
            'org-1',
            'DNS',
        );
    });

    it.each([
        { config: { recordType: 'MX' } },
        { config: { password: 'not-supported' } },
        { config: null },
        { type: 'MYSQL' },
        { organizationId: 'foreign-org' },
    ])('rejects invalid or cross-tenant input %j', async (overrides) => {
        await request(app.getHttpServer())
            .post('/api/projects/project-1/monitors')
            .send({
                name: 'DNS',
                type: 'DNS',
                target: 'example.com',
                ...overrides,
            })
            .expect(400);
        expect(prisma.monitor.create).not.toHaveBeenCalled();
    });

    it('denies non-members and insufficient roles with the real guard', async () => {
        prisma.membership.findUnique.mockResolvedValue(null);
        await request(app.getHttpServer())
            .post('/api/projects/project-1/monitors')
            .send({ name: 'DNS', type: 'DNS', target: 'example.com' })
            .expect(404);
        prisma.membership.findUnique.mockResolvedValue({
            id: 'membership',
            role: 'VIEWER',
        });
        prisma.projectMembership.findUnique.mockResolvedValue({
            organizationId: 'org-1',
            role: 'VIEWER',
        });
        await request(app.getHttpServer())
            .post('/api/projects/project-1/monitors')
            .send({ name: 'DNS', type: 'DNS', target: 'example.com' })
            .expect(403);
        expect(prisma.monitor.create).not.toHaveBeenCalled();
    });

    it('creates an HTTP assertion definition through the actual DTO/service pipeline', async () => {
        const response = await request(app.getHttpServer())
            .post('/api/projects/project-1/monitors')
            .send({
                name: 'Health assertions',
                type: 'HTTP',
                target: 'https://example.com/health',
                config: {
                    keyword: 'healthy',
                    jsonAssertions: [
                        {
                            path: '/data/status',
                            operator: 'eq',
                            value: 'healthy',
                        },
                    ],
                },
            })
            .expect(201);
        expect(response.body.data.config).toEqual({
            keyword: 'healthy',
            keywordMode: 'contains',
            jsonAssertions: [
                { path: '/data/status', operator: 'eq', value: 'healthy' },
            ],
            maxBodyBytes: 65536,
        });
        expect(response.body.data.configVersion).toBe(1);
        expect(response.body.data.revision).toBe(1);
    });

    it.each([
        { keywordMode: 'contains' },
        { keyword: 'x', maxBodyBytes: 1048577 },
        { jsonAssertions: [{ path: '$.status', operator: 'exists' }] },
        { jsonAssertions: [{ path: '/__proto__', operator: 'exists' }] },
        { jsonAssertions: [{ path: '/status', operator: 'eq' }] },
        {
            jsonAssertions: [
                { path: '/status', operator: 'exists', value: null },
            ],
        },
        { jsonAssertions: [{ path: '/status', operator: 'eq', value: {} }] },
        {
            jsonAssertions: [
                { path: '/status', operator: 'exists', script: 'unsupported' },
            ],
        },
    ])(
        'rejects nested HTTP assertion input %# without persistence',
        async (config) => {
            await request(app.getHttpServer())
                .post('/api/projects/project-1/monitors')
                .send({
                    name: 'HTTP',
                    type: 'HTTP',
                    target: 'https://example.com',
                    config,
                })
                .expect(400);
            expect(prisma.monitor.create).not.toHaveBeenCalled();
        },
    );

    it('replaces HTTP config and increments revision through PATCH', async () => {
        const existing = {
            id: 'monitor-1',
            projectId: 'project-1',
            organizationId: 'org-1',
            type: 'HTTP',
            target: 'https://example.com',
            revision: 1,
            enabled: true,
            interval: 60,
            config: {
                keyword: 'healthy',
                keywordMode: 'contains',
                maxBodyBytes: 65536,
            },
        };
        prisma.monitor.findFirst.mockResolvedValue(existing);
        prisma.monitor.update.mockImplementation(({ data }) => ({
            ...existing,
            ...data,
            revision: 2,
            state: null,
        }));
        const response = await request(app.getHttpServer())
            .patch('/api/projects/project-1/monitors/monitor-1')
            .send({
                config: {
                    jsonAssertions: [{ path: '/status', operator: 'exists' }],
                },
            })
            .expect(200);
        expect(response.body.data.config).toEqual({
            jsonAssertions: [{ path: '/status', operator: 'exists' }],
            maxBodyBytes: 65536,
        });
        expect(response.body.data.revision).toBe(2);
        expect(prisma.monitor.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    id: 'monitor-1',
                    projectId: 'project-1',
                    organizationId: 'org-1',
                    revision: 1,
                    deletedAt: null,
                },
                data: expect.objectContaining({ revision: { increment: 1 } }),
            }),
        );
    });

    describe('probe assignment', () => {
        const existing = {
            id: 'monitor-1',
            projectId: 'project-1',
            organizationId: 'org-1',
            name: 'Health',
            type: 'HTTP',
            target: 'https://example.com/health',
            interval: 60,
            timeout: 5000,
            expectedStatus: 200,
            failureThreshold: 3,
            probeSuccessRatio: 1,
            checkSsl: false,
            sslExpiryThreshold: 30,
            enabled: true,
            availabilityEnabled: false,
            availabilityThreshold: 90,
            availabilityWindow: 10,
            config: {},
            configVersion: 1,
            revision: 1,
            deletedAt: null,
        };

        it('replaces the probe set through the DTO pipeline', async () => {
            prisma.monitor.findFirst.mockResolvedValue(existing);
            prisma.probe.count.mockResolvedValue(1);
            prisma.monitorProbe.deleteMany.mockResolvedValue({ count: 1 });
            prisma.monitorProbe.createMany.mockResolvedValue({ count: 1 });
            prisma.monitor.findFirstOrThrow.mockResolvedValue({
                ...existing,
                state: null,
                notificationChannels: [],
                probes: [
                    {
                        probe: {
                            id: 'probe-1',
                            name: 'Tokyo probe',
                            provider: 'TENCENT',
                            region: 'ap-northeast-1',
                            status: 'ONLINE',
                            enabled: true,
                            lastHeartbeat: null,
                        },
                    },
                ],
            });

            const response = await request(app.getHttpServer())
                .patch('/api/projects/project-1/monitors/monitor-1/probes')
                .send({ probeIds: ['probe-1'] })
                .expect(200);

            expect(prisma.monitorProbe.deleteMany).toHaveBeenCalledWith({
                where: { monitorId: 'monitor-1' },
            });
            expect(prisma.monitorProbe.createMany).toHaveBeenCalledWith({
                data: [{ monitorId: 'monitor-1', probeId: 'probe-1' }],
                skipDuplicates: true,
            });
            expect(response.body.data.probes).toHaveLength(1);
            expect(response.body.data.probes[0].id).toBe('probe-1');
            expect(response.body.data.maxProbes).toBe(10);
        });

        it('rejects a non-array probeIds body through the validation pipe', async () => {
            await request(app.getHttpServer())
                .patch('/api/projects/project-1/monitors/monitor-1/probes')
                .send({ probeIds: 'probe-1' })
                .expect(400);
            expect(prisma.monitorProbe.deleteMany).not.toHaveBeenCalled();
        });
    });

    describe('probe success ratio', () => {
        const base = {
            name: 'Health',
            type: 'HTTP',
            target: 'https://example.com/health',
        };

        it('leaves the ratio to the database default when omitted', async () => {
            const response = await request(app.getHttpServer())
                .post('/api/projects/project-1/monitors')
                .send(base)
                .expect(201);

            expect(
                prisma.monitor.create.mock.calls[0][0].data.probeSuccessRatio,
            ).toBeUndefined();
            expect(response.body.data.probeSuccessRatio).toBe(1);
        });

        it('persists an explicit ratio and returns it', async () => {
            const response = await request(app.getHttpServer())
                .post('/api/projects/project-1/monitors')
                .send({ ...base, probeSuccessRatio: 60 })
                .expect(201);

            expect(
                prisma.monitor.create.mock.calls[0][0].data.probeSuccessRatio,
            ).toBe(60);
            expect(response.body.data.probeSuccessRatio).toBe(60);
        });

        it('accepts a convertible integer string like the production pipe', async () => {
            const response = await request(app.getHttpServer())
                .post('/api/projects/project-1/monitors')
                .send({ ...base, probeSuccessRatio: '100' })
                .expect(201);

            expect(
                prisma.monitor.create.mock.calls[0][0].data.probeSuccessRatio,
            ).toBe(100);
            expect(response.body.data.probeSuccessRatio).toBe(100);
        });

        it.each([0, 101, -1, 1.5, null, '', 'abc'])(
            'rejects the out-of-range value %p without persisting',
            async (probeSuccessRatio) => {
                await request(app.getHttpServer())
                    .post('/api/projects/project-1/monitors')
                    .send({ ...base, probeSuccessRatio })
                    .expect(400);

                expect(prisma.monitor.create).not.toHaveBeenCalled();
            },
        );

        it('revises the monitor when the ratio changes through PATCH', async () => {
            const existing = {
                id: 'monitor-1',
                projectId: 'project-1',
                organizationId: 'org-1',
                type: 'HTTP',
                target: 'https://example.com',
                revision: 1,
                enabled: true,
                interval: 60,
                probeSuccessRatio: 1,
                config: {},
            };
            prisma.monitor.findFirst.mockResolvedValue(existing);
            prisma.monitor.update.mockImplementation(({ data }) => ({
                ...existing,
                ...data,
                revision: 2,
                state: null,
            }));

            const response = await request(app.getHttpServer())
                .patch('/api/projects/project-1/monitors/monitor-1')
                .send({ probeSuccessRatio: 100 })
                .expect(200);

            expect(response.body.data.probeSuccessRatio).toBe(100);
            expect(prisma.monitor.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        probeSuccessRatio: 100,
                        revision: { increment: 1 },
                    }),
                }),
            );
        });

        it('keeps the revision for an unchanged or omitted ratio', async () => {
            const existing = {
                id: 'monitor-1',
                projectId: 'project-1',
                organizationId: 'org-1',
                type: 'HTTP',
                target: 'https://example.com',
                revision: 1,
                enabled: true,
                interval: 60,
                probeSuccessRatio: 60,
                config: {},
            };
            prisma.monitor.findFirst.mockResolvedValue(existing);
            prisma.monitor.update.mockImplementation(({ data }) => ({
                ...existing,
                ...data,
                state: null,
            }));

            await request(app.getHttpServer())
                .patch('/api/projects/project-1/monitors/monitor-1')
                .send({ probeSuccessRatio: 60 })
                .expect(200);
            await request(app.getHttpServer())
                .patch('/api/projects/project-1/monitors/monitor-1')
                .send({ name: 'Renamed' })
                .expect(200);

            expect(
                prisma.monitor.update.mock.calls[0][0].data.revision,
            ).toBeUndefined();
            expect(
                prisma.monitor.update.mock.calls[1][0].data.revision,
            ).toBeUndefined();
        });
    });

    it('documents the nested HTTP config and response schema in Swagger', () => {
        const document = SwaggerModule.createDocument(
            app,
            new DocumentBuilder().build(),
        );
        for (const name of [
            'CreateMonitorDto',
            'UpdateMonitorDto',
            'MonitorEntity',
        ]) {
            expect(document.components?.schemas?.[name]).toMatchObject({
                properties: {
                    config: {
                        anyOf: expect.arrayContaining([
                            expect.objectContaining({
                                title: 'HTTP configuration',
                                additionalProperties: false,
                                properties: expect.objectContaining({
                                    maxBodyBytes: expect.objectContaining({
                                        maximum: 1048576,
                                    }),
                                    jsonAssertions: expect.objectContaining({
                                        maxItems: 10,
                                    }),
                                }),
                            }),
                        ]),
                    },
                },
            });
        }
    });
});
