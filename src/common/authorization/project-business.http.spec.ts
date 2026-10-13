import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaModule } from '../../infra/database/prisma.module';
import { PrismaService } from '../../infra/database/prisma.service';
import { AuthorizationModule } from './authorization.module';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { TasksController } from '../../modules/tasks/tasks.controller';
import { TasksService } from '../../modules/tasks/tasks.service';
import { CommentsController } from '../../modules/comments/comments.controller';
import { CommentsService } from '../../modules/comments/comments.service';
import { AttachmentsController } from '../../modules/attachments/attachments.controller';
import { AttachmentsService } from '../../modules/attachments/attachments.service';
import { MonitorsController } from '../../modules/monitors/monitors.controller';
import { MonitorsService } from '../../modules/monitors/monitors.service';
import { CheckerController } from '../../modules/checker/checker.controller';
import { CheckerService } from '../../modules/checker/checker.service';
import { SprintsController } from '../../modules/sprints/sprints.controller';
import { SprintsService } from '../../modules/sprints/sprints.service';
import {
    ProjectLabelsController,
    TaskLabelsController,
} from '../../modules/labels/labels.controller';
import { LabelsService } from '../../modules/labels/labels.service';
import { StateController } from '../../modules/state/state.controller';
import { StateService } from '../../modules/state/state.service';
import { RuleBindingsController } from '../../modules/rules/rule-bindings.controller';
import { RuleBindingsService } from '../../modules/rules/rule-bindings.service';
import {
    PATH_METADATA,
    METHOD_METADATA,
    GUARDS_METADATA,
} from '@nestjs/common/constants';
import { PROJECT_PERMISSION_KEY } from './project-permission.decorator';
import { ProjectAccessGuard } from './project-access.guard';
import { MonitoringDashboardController } from '../../modules/monitoring/monitoring-dashboard.controller';
import { MonitoringDashboardService } from '../../modules/monitoring/monitoring-dashboard.service';
import { MultiLevelCacheService } from '../../infra/cache/multi-level-cache.service';
import { SystemProbeScheduler } from '../../modules/admin/system-probes/system-probe-scheduler';
import { MonitorInsightsController } from '../../modules/monitoring/monitor-insights.controller';
import { MonitorInsightsService } from '../../modules/monitoring/monitor-insights.service';
import { AlertEventsController } from '../../modules/alert-events/alert-events.controller';
import { AlertEventsService } from '../../modules/alert-events/alert-events.service';

const controllers = [
    TasksController,
    CommentsController,
    AttachmentsController,
    MonitorsController,
    CheckerController,
    SprintsController,
    ProjectLabelsController,
    TaskLabelsController,
    StateController,
    RuleBindingsController,
    MonitoringDashboardController,
    MonitorInsightsController,
    AlertEventsController,
];
const serviceTypes = [
    TasksService,
    CommentsService,
    AttachmentsService,
    MonitorsService,
    CheckerService,
    SprintsService,
    LabelsService,
    StateService,
    RuleBindingsService,
    MonitorInsightsService,
    AlertEventsService,
];
const routes = [
    ['post', '/projects/P/tasks'],
    ['patch', '/projects/P/tasks/P-task'],
    ['delete', '/projects/P/tasks/P-task'],
    ['patch', '/projects/P/tasks/P-task/restore'],
    ['patch', '/projects/P/tasks/P-task/assign'],
    ['patch', '/projects/P/tasks/P-task/move'],
    ['post', '/projects/P/tasks/P-task/dependencies'],
    ['delete', '/projects/P/tasks/P-task/dependencies/dependency'],
    ['post', '/tasks/P-task/comments'],
    ['patch', '/tasks/P-task/comments/P-comment'],
    ['delete', '/tasks/P-task/comments/P-comment'],
    ['post', '/tasks/P-task/attachments'],
    ['post', '/tasks/P-task/attachments/upload'],
    ['delete', '/tasks/P-task/attachments/P-attachment'],
    ['post', '/projects/P/sprints'],
    ['patch', '/projects/P/sprints/P-sprint'],
    ['post', '/projects/P/sprints/P-sprint/start'],
    ['post', '/projects/P/sprints/P-sprint/complete'],
    ['delete', '/projects/P/sprints/P-sprint'],
    ['post', '/projects/P/labels'],
    ['post', '/tasks/P-task/labels/label'],
    ['delete', '/tasks/P-task/labels/label'],
    ['post', '/projects/P/monitors'],
    ['patch', '/projects/P/monitors/P-monitor'],
    ['delete', '/projects/P/monitors/P-monitor'],
    ['post', '/projects/P/monitors/P-monitor/pause'],
    ['post', '/projects/P/monitors/P-monitor/resume'],
    ['post', '/projects/P/monitors/P-monitor/restore'],
    ['post', '/projects/P/monitors/P-monitor/test-alert'],
    ['post', '/projects/P/monitors/P-monitor/check'],
    ['post', '/projects/P/monitoring/alert-deliveries/delivery/retry'],
    ['post', '/projects/P/monitors/P-monitor/rule-bindings'],
    ['delete', '/projects/P/monitors/P-monitor/rule-bindings/rule'],
] as const;
const readRoutes = [
    '/projects/P/tasks',
    '/projects/P/tasks/backlog',
    '/projects/P/tasks/P-task',
    '/projects/P/tasks/P-task/activities',
    '/tasks/P-task/comments',
    '/tasks/P-task/attachments',
    '/tasks/P-task/attachments/P-attachment/download',
    '/projects/P/sprints',
    '/projects/P/sprints/P-sprint',
    '/projects/P/labels',
    '/projects/P/monitors',
    '/projects/P/monitors/P-monitor',
    '/projects/P/monitors/P-monitor/checks',
    '/projects/P/monitors/P-monitor/state',
    '/projects/P/monitors/P-monitor/insights',
    '/projects/P/monitors/P-monitor/rule-bindings',
] as const;

// Real HTTP routing and guards; business delegates are mocked. Database-backed
// migration and concurrency acceptance is a separate disposable-db suite.
describe('Project business HTTP access boundaries', () => {
    let app: INestApplication;
    let token: string;
    const work = jest.fn().mockResolvedValue([]);
    const snapshot = {
        value: 7,
        target: 'https://internal.test',
        config: { body: 'private' },
        credential: 'never-return',
        nested: { requestHeaders: { Authorization: 'private' } },
    };
    const cache = { getOrSet: jest.fn().mockResolvedValue(snapshot) };
    const db = {
        user: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'user',
                globalRole: 'USER',
                email: 'user@example.test',
            }),
        },
        organization: { findFirst: jest.fn().mockResolvedValue({ id: 'org' }) },
        membership: {
            findUnique: jest.fn().mockResolvedValue({
                id: 'membership',
                role: 'MEMBER',
                projectPermissionsVersion: 1,
            }),
        },
        project: {
            findFirst: jest.fn().mockImplementation(({ where }) =>
                Promise.resolve(
                    ['a', 'b', 'c'].includes(where.id)
                        ? {
                              id: where.id,
                              organizationId: 'org',
                              status: 'ACTIVE',
                          }
                        : null,
                ),
            ),
        },
        projectMembership: {
            findUnique: jest.fn().mockImplementation(({ where }) => {
                const project = where.membershipId_projectId.projectId;
                return Promise.resolve(
                    project === 'c'
                        ? null
                        : {
                              organizationId: 'org',
                              role: project === 'a' ? 'VIEWER' : 'ADMIN',
                          },
                );
            }),
        },
        task: {
            findFirst: jest.fn().mockImplementation(({ where }) =>
                Promise.resolve({
                    id: where.id,
                    projectId: where.id.split('-')[0],
                    organizationId: 'org',
                }),
            ),
        },
        monitor: {
            findFirst: jest.fn().mockImplementation(({ where }) =>
                Promise.resolve({
                    projectId: where.id.split('-')[0],
                    organizationId: 'org',
                }),
            ),
        },
        sprint: {
            findUnique: jest
                .fn()
                .mockImplementation(({ where }) =>
                    Promise.resolve({ projectId: where.id.split('-')[0] }),
                ),
        },
        comment: {
            findFirst: jest.fn().mockImplementation(({ where }) => {
                const projectId = where.id.split('-')[0];
                return Promise.resolve({
                    taskId: `${projectId}-task`,
                    task: { projectId, organizationId: 'org' },
                });
            }),
        },
        attachment: {
            findFirst: jest.fn().mockImplementation(({ where }) => {
                const projectId = where.id.split('-')[0];
                return Promise.resolve({
                    taskId: `${projectId}-task`,
                    task: { projectId, organizationId: 'org' },
                });
            }),
        },
    };

    beforeAll(async () => {
        const providers = serviceTypes.map((type) => ({
            provide: type,
            useValue: Object.fromEntries(
                Object.getOwnPropertyNames(type.prototype)
                    .filter((key) => key !== 'constructor')
                    .map((key) => [key, work]),
            ),
        }));
        const moduleRef = await Test.createTestingModule({
            imports: [
                PrismaModule,
                AuthorizationModule,
                JwtModule.register({
                    secret: 'business-http-unit-secret',
                }),
            ],
            controllers,
            providers: [
                ...providers,
                MonitoringDashboardService,
                { provide: MultiLevelCacheService, useValue: cache },
                { provide: SystemProbeScheduler, useValue: {} },
                { provide: APP_GUARD, useClass: JwtAuthGuard },
            ],
        })
            .overrideProvider(PrismaService)
            .useValue(db)
            .compile();
        app = moduleRef.createNestApplication();
        app.setGlobalPrefix('api');
        app.useGlobalPipes(
            new ValidationPipe({
                whitelist: true,
                forbidNonWhitelisted: true,
                transform: true,
            }),
        );
        await app.init();
        token = await moduleRef
            .get(JwtService)
            .signAsync({ sub: 'user', globalRole: 'SUPER_ADMIN' });
    });
    afterAll(async () => app.close());
    beforeEach(() => jest.clearAllMocks());

    it.each(routes)(
        'rejects VIEWER %s %s without invoking business code',
        async (method, route) => {
            const response = await request(app.getHttpServer())
                [method](`/api${route.replaceAll('P', 'a')}`)
                .set('Authorization', `Bearer ${token}`)
                .send({});
            expect(response.status).toBe(403);
            expect(work).not.toHaveBeenCalled();
        },
    );

    it.each([...routes, ...readRoutes.map((route) => ['get', route] as const)])(
        'hides ungranted project for %s %s',
        async (method, route) => {
            const response = await request(app.getHttpServer())
                [method](`/api${route.replaceAll('P', 'c')}`)
                .set('Authorization', `Bearer ${token}`)
                .send({});
            expect(response.status).toBe(404);
            expect(work).not.toHaveBeenCalled();
        },
    );

    it.each(['post', 'delete'] as const)(
        'allows VIEWER %s own subscription',
        async (method) => {
            const response = await request(app.getHttpServer())
                [method]('/api/projects/a/tasks/a-task/watch')
                .set('Authorization', `Bearer ${token}`);
            expect(response.status).toBe(204);
            expect(work).toHaveBeenCalledWith('a', 'a-task', 'user');
        },
    );

    it.each([
        '/projects/b/tasks/a-task',
        '/projects/b/monitors/a-monitor',
        '/tasks/b-task/comments/a-comment',
    ])('checks implicit parent route binding on %s', async (route) => {
        const method = route.includes('comments') ? 'patch' : 'get';
        const response = await request(app.getHttpServer())
            [method](`/api${route}`)
            .set('Authorization', `Bearer ${token}`)
            .send({});
        expect(response.status).toBe(404);
        expect(work).not.toHaveBeenCalled();
    });

    it('reauthorizes before cached snapshots and never reuses an ETag after revocation', async () => {
        const first = await request(app.getHttpServer())
            .get('/api/projects/b/monitoring/status-codes')
            .set('Authorization', `Bearer ${token}`);
        expect(first.status).toBe(200);
        expect(first.body.data.target).toBe(snapshot.target);
        expect(first.body.data).not.toHaveProperty('credential');
        db.projectMembership.findUnique.mockResolvedValueOnce(null);
        const before = cache.getOrSet.mock.calls.length;
        const revoked = await request(app.getHttpServer())
            .get('/api/projects/b/monitoring/status-codes')
            .set('Authorization', `Bearer ${token}`)
            .set('If-None-Match', first.headers.etag);
        expect(revoked.status).toBe(404);
        expect(cache.getOrSet.mock.calls.length).toBe(before);
    });

    it('projects cached snapshots using the current role and cannot emit a former-admin 304', async () => {
        const first = await request(app.getHttpServer())
            .get('/api/projects/b/monitoring/status-codes')
            .set('Authorization', `Bearer ${token}`);
        const grant = db.projectMembership.findUnique.getMockImplementation()!;
        db.projectMembership.findUnique.mockImplementation(({ where }) =>
            where.membershipId_projectId.projectId === 'b'
                ? Promise.resolve({ organizationId: 'org', role: 'VIEWER' })
                : grant({ where }),
        );
        try {
            const lowered = await request(app.getHttpServer())
                .get('/api/projects/b/monitoring/status-codes')
                .set('Authorization', `Bearer ${token}`)
                .set('If-None-Match', first.headers.etag);
            expect(lowered.status).toBe(200);
            expect(lowered.body.data.target).toBe('[REDACTED]');
            expect(lowered.body.data).not.toHaveProperty('config');
            expect(lowered.body.data.nested).not.toHaveProperty(
                'requestHeaders',
            );
            expect(lowered.headers.etag).not.toBe(first.headers.etag);
            expect(snapshot.config).toEqual({ body: 'private' });
            const unchanged = await request(app.getHttpServer())
                .get('/api/projects/b/monitoring/status-codes')
                .set('Authorization', `Bearer ${token}`)
                .set('If-None-Match', lowered.headers.etag);
            expect(unchanged.status).toBe(304);
        } finally {
            db.projectMembership.findUnique.mockImplementation(grant);
        }
    });

    it.each(controllers)(
        '%s has explicit project policy on every registered route',
        (controller) => {
            for (const key of Object.getOwnPropertyNames(
                controller.prototype,
            )) {
                const handler = controller.prototype[key];
                if (
                    typeof handler !== 'function' ||
                    Reflect.getMetadata(METHOD_METADATA, handler) === undefined
                )
                    continue;
                expect(
                    Reflect.getMetadata(PATH_METADATA, handler),
                ).toBeDefined();
                expect(
                    Reflect.getMetadata(PROJECT_PERMISSION_KEY, handler) ??
                        Reflect.getMetadata(PROJECT_PERMISSION_KEY, controller),
                ).toBeDefined();
                expect([
                    ...(Reflect.getMetadata(GUARDS_METADATA, controller) ?? []),
                    ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? []),
                ]).toContain(ProjectAccessGuard);
            }
        },
    );
});
