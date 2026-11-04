import { ValidationPipe, type ExecutionContext } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ProjectAccessGuard } from '../../common/authorization/project-access.guard';
import { RumAlertRulesController } from './alerts/rum-alert-rules.controller';
import { RumAlertRulesService } from './alerts/rum-alert-rules.service';
import { RumEventsController } from './events/rum-events.controller';
import { RumEventsService } from './events/rum-events.service';
import { RumReplaysController } from './replays/rum-replays.controller';
import { RumReplaysService } from './replays/rum-replays.service';
import { ProjectRumController } from './project/project-rum.controller';
import { ProjectRumService } from './project/project-rum.service';

describe('RUM numeric query endpoints', () => {
    it('accepts HTTP query strings and documents numeric query types', async () => {
        const echoQuery = (_project: string, _app: string, query: object) =>
            query;
        const module = await Test.createTestingModule({
            controllers: [
                RumAlertRulesController,
                RumEventsController,
                RumReplaysController,
                ProjectRumController,
            ],
            providers: [
                {
                    provide: RumAlertRulesService,
                    useValue: { incidents: echoQuery },
                },
                {
                    provide: RumEventsService,
                    useValue: { findAll: echoQuery, stats: echoQuery },
                },
                {
                    provide: RumReplaysService,
                    useValue: {
                        findAll: echoQuery,
                        chunks: (
                            _p: string,
                            _a: string,
                            _r: string,
                            query: object,
                        ) => query,
                    },
                },
                {
                    provide: ProjectRumService,
                    useValue: { events: (_p: string, query: object) => query },
                },
            ],
        })
            .overrideGuard(ProjectAccessGuard)
            .useValue({
                canActivate: (context: ExecutionContext) => {
                    const req = context
                        .switchToHttp()
                        .getRequest<{ accessPrincipal: object }>();
                    req.accessPrincipal = { type: 'USER', userId: 'test-user' };
                    return true;
                },
            })
            .compile();
        const app = module.createNestApplication();
        app.setGlobalPrefix('api');
        app.useGlobalPipes(
            new ValidationPipe({
                whitelist: true,
                forbidNonWhitelisted: false,
                transform: true,
                transformOptions: { enableImplicitConversion: true },
            }),
        );
        await app.init();
        try {
            const base = '/api/projects/project/apps/app';
            const cases: [string, object][] = [
                [
                    `${base}/alerts/incidents?status=OPEN&page=1&limit=5`,
                    { status: 'OPEN', page: 1, limit: 5 },
                ],
                [`${base}/events/stats?days=7`, { days: 7 }],
                [`${base}/events?page=1&limit=5`, { page: 1, limit: 5 }],
                [`${base}/replays?page=1&limit=5`, { page: 1, limit: 5 }],
                [
                    `${base}/replays/replay/chunks?afterSequence=-1&limit=50`,
                    { afterSequence: -1, limit: 50 },
                ],
                [
                    '/api/projects/project/rum/events?page=1&limit=5&appId=app',
                    { page: 1, limit: 5, appId: 'app' },
                ],
            ];
            for (const [url, expected] of cases) {
                const response = await request(app.getHttpServer())
                    .get(url)
                    .expect(200);
                expect(response.body).toMatchObject(expected);
            }
            await request(app.getHttpServer())
                .get(`${base}/events/stats?days=91`)
                .expect(400);
            const document = SwaggerModule.createDocument(
                app,
                new DocumentBuilder().setTitle('test').build(),
            );
            const appPath = '/api/projects/{projectId}/apps/{appId}';
            const endpoints: [string, string[]][] = [
                [`${appPath}/alerts/incidents`, ['page', 'limit']],
                [`${appPath}/events`, ['page', 'limit']],
                [`${appPath}/events/stats`, ['days']],
                [`${appPath}/replays`, ['page', 'limit']],
                [
                    `${appPath}/replays/{replayId}/chunks`,
                    ['afterSequence', 'limit'],
                ],
                ['/api/projects/{projectId}/rum/events', ['page', 'limit']],
            ];
            for (const [path, names] of endpoints) {
                const parameters = document.paths[path]?.get?.parameters;
                expect(parameters).toBeDefined();
                for (const name of names) {
                    expect(parameters).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({
                                name,
                                in: 'query',
                                schema: expect.objectContaining({
                                    type: 'number',
                                }),
                            }),
                        ]),
                    );
                }
            }
        } finally {
            await app.close();
        }
    });
});
