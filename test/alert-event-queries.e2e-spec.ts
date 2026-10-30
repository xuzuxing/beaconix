import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { JwtService } from '@nestjs/jwt';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { PrismaService } from '../src/infra/database/prisma.service';
import { ProjectAccessService } from '../src/common/authorization/project-access.service';
import { ResourceContextResolver } from '../src/common/authorization/resource-context.resolver';
import { AlertEventQueriesController } from '../src/modules/alert-events/alert-event-queries.controller';
import { AlertEventQueriesService } from '../src/modules/alert-events/alert-event-queries.service';
import { AlertEventsController } from '../src/modules/alert-events/alert-events.controller';
import { AlertEventsService } from '../src/modules/alert-events/alert-events.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { configureBusinessApp } from './fixtures/business-http.fixture';
import {
    alertIds,
    alertQueriesFixture,
} from './fixtures/alert-event-queries.fixture';

describe('Project incident investigation HTTP (offline)', () => {
    let app: INestApplication;
    let jwt: JwtService;
    let f: ReturnType<typeof alertQueriesFixture>;
    const base = '/api/projects/project/monitoring/alert-events';
    beforeEach(async () => {
        f = alertQueriesFixture();
        const module = await Test.createTestingModule({
            controllers: [AlertEventQueriesController, AlertEventsController],
            providers: [
                AlertEventQueriesService,
                AlertEventsService,
                ResourceContextResolver,
                { provide: PrismaService, useValue: f.db },
                { provide: ProjectAccessService, useValue: f.access },
                { provide: NotificationsService, useValue: {} },
            ],
        }).compile();
        app = module.createNestApplication();
        jwt = configureBusinessApp(app, f.db, {
            forbidNonWhitelisted: false,
            transformOptions: { enableImplicitConversion: true },
        });
        await app.init();
    });
    afterEach(async () => app?.close());
    const user = (id: string) => ({
        type: 'bearer' as const,
        token: jwt.sign({ sub: id }),
    });
    function get(path = '', id = 'admin', query = {}) {
        const auth = user(id);
        return request(app.getHttpServer())
            .get(base + path)
            .auth(auth.token, { type: auth.type })
            .query(query);
    }
    function retry(id = 'admin', delivery = 'delivery-1') {
        return request(app.getHttpServer())
            .post(
                `/api/projects/project/monitoring/alert-deliveries/${delivery}/retry`,
            )
            .auth(user(id).token, { type: 'bearer' });
    }

    it('requires a current identity and explicit project visibility', async () => {
        await request(app.getHttpServer()).get(base).expect(401);
        await get('', 'outsider').expect(404);
        await get('', 'unassigned').expect(404);
        expect(f.db.alertEvent.findMany).not.toHaveBeenCalled();
        for (const role of ['viewer', 'member', 'admin', 'orgAdmin', 'super']) {
            expect((await get('', role).expect(200)).body.data.total).toBe(2);
        }
    });

    it('filters by monitor, kind, level, lifecycle and inclusive start time; paginates stably', async () => {
        const filtered = await get('', 'admin', {
            monitorId: alertIds.monitor,
            kind: 'NO_DATA',
            level: 'warning',
            status: 'ongoing',
            from: '2026-10-29T01:00:00Z',
            to: '2026-10-29T01:00:00Z',
        }).expect(200);
        expect(filtered.body.data.total).toBe(1);
        expect(filtered.body.data.items[0].id).toBe('event-1');
        const first = await get('', 'admin', { limit: 1 }).expect(200);
        const second = await get('', 'admin', { page: 2, limit: 1 }).expect(
            200,
        );
        expect(first.body.data).toMatchObject({
            total: 2,
            page: 1,
            limit: 1,
            items: [{ id: 'event-1' }],
        });
        expect(second.body.data.items[0]).toMatchObject({
            id: 'event-2',
            monitorDeleted: true,
            durationSeconds: 60,
        });
        expect(
            (await get('', 'admin', { page: 3, limit: 1 }).expect(200)).body
                .data.items,
        ).toEqual([]);
    });

    it('reads historical event details without exposing another project or tenant', async () => {
        for (const id of ['sibling-event', 'foreign-event', 'missing']) {
            await get(`/${id}`).expect(404);
            await get(`/${id}/deliveries`).expect(404);
        }
        const detail = (await get('/event-2').expect(200)).body.data;
        expect(detail).toMatchObject({
            monitorName: 'Old API',
            monitorDeleted: true,
            status: 'resolved',
            durationSeconds: 60,
            canRetryDeliveries: true,
        });
        expect(detail.deliverySummary).toEqual([
            { status: 'SUCCESS', count: 1 },
        ]);
    });

    it('projects safe fields and respects lower-role target redaction on every read', async () => {
        const admin = (await get('/event-1').expect(200)).body.data;
        expect(admin.target).toContain('api.test');
        expect(admin.target).not.toMatch(/target-password|target-token/);
        const viewer = (await get('/event-1', 'viewer').expect(200)).body.data;
        expect(viewer.target).toBe('[REDACTED]');
        expect(viewer.canRetryDeliveries).toBe(false);
        for (const path of [
            '',
            '/event-1',
            '/event-1/deliveries',
            '/event-1/deliveries/delivery-1/attempts',
        ]) {
            const res = await get(path).expect(200);
            expect(JSON.stringify(res.body)).not.toMatch(
                /raw-private|evidence-secret|payload-secret|provider-secret|lease-secret|channel-secret|private@example|log-secret|latestEvidence|lastError|leaseToken|"error"|"config"|"payload"/,
            );
        }
    });

    it('links deliveries to safe current channel metadata and handles deleted channels', async () => {
        const response = (await get('/event-1/deliveries').expect(200)).body
            .data;
        expect(response).toMatchObject({
            total: 2,
            items: [
                {
                    id: 'delivery-1',
                    status: 'FAILED',
                    canRetry: true,
                    channel: {
                        id: 'channel-1',
                        name: 'On-call email',
                        type: 'EMAIL',
                    },
                },
                {
                    id: 'delivery-deleted-channel',
                    channel: null,
                    canRetry: false,
                },
            ],
        });
        expect(
            (
                await get('/event-1/deliveries', 'admin', {
                    status: 'FAILED',
                    phase: 'OPEN',
                    limit: 1,
                }).expect(200)
            ).body.data.total,
        ).toBe(1);
        expect(
            (await get('/event-1/deliveries', 'viewer').expect(200)).body.data
                .items[0].canRetry,
        ).toBe(false);
        f.channels[0].organizationId = 'foreign-org';
        expect(
            (await get('/event-1/deliveries').expect(200)).body.data.items[0]
                .channel,
        ).toBeNull();
    });

    it('paginates attempt history and rejects a delivery from a different event', async () => {
        const response = (
            await get('/event-1/deliveries/delivery-1/attempts', 'admin', {
                limit: 1,
                page: 2,
            }).expect(200)
        ).body.data;
        expect(response).toMatchObject({
            total: 3,
            items: [{ id: 'log-2', attempt: 2, status: 'FAILED' }],
        });
        await get('/event-1/deliveries/other-delivery/attempts').expect(404);
        await get('/event-1/deliveries/missing/attempts').expect(404);
    });

    it('retries through the existing endpoint, preserving history and rejecting duplicate or unauthorized retry', async () => {
        f.deliveries.push({
            ...f.deliveries[0],
            id: 'foreign-delivery',
            eventId: 'sibling-event',
        });
        await retry('viewer').expect(403);
        await retry('member').expect(403);
        await retry('admin', 'foreign-delivery').expect(409);
        expect((await retry().expect(200)).body.data).toEqual({
            id: 'delivery-1',
            status: 'PENDING',
        });
        await retry().expect(409);
        const row = (
            await get('/event-1/deliveries', 'admin', {
                status: 'PENDING',
            }).expect(200)
        ).body.data.items[0];
        expect(row).toMatchObject({
            attempts: 0,
            status: 'PENDING',
            canRetry: false,
        });
        expect(
            (await get('/event-1/deliveries/delivery-1/attempts').expect(200))
                .body.data.total,
        ).toBe(3);
    });

    it('keeps archived history readable and blocks retry; deleted projects and tenants are hidden', async () => {
        f.projects[0].status = 'ARCHIVED';
        expect(
            (await get('/event-1').expect(200)).body.data.canRetryDeliveries,
        ).toBe(false);
        expect(
            (await get('/event-1/deliveries').expect(200)).body.data.items[0]
                .canRetry,
        ).toBe(false);
        await retry().expect(403);
        f.projects[0].deletedAt = new Date() as any;
        await get().expect(404);
        f.projects[0].deletedAt = null;
        f.orgs[0].deletedAt = new Date() as any;
        await get().expect(404);
    });

    it.each([
        { kind: 'BOGUS' },
        { status: 'ACKED' },
        { level: 'info' },
        { page: 0 },
        { limit: 101 },
        { page: 1000001 },
        { monitorId: 'invalid' },
        { from: 'bad-date' },
        { from: '2026-10-30', to: '2026-10-29' },
        { from: '2026-W44-5' },
        { to: '2026-303' },
        { from: '2026-02-30' },
    ])('rejects invalid event query %j', async (query) => {
        await get('', 'admin', query).expect(400);
        expect(f.db.alertEvent.findMany).not.toHaveBeenCalled();
    });

    it('rejects invalid nested queries without reading history', async () => {
        await get('/event-1/deliveries', 'admin', { phase: 'BAD' }).expect(400);
        await get('/event-1/deliveries', 'admin', { status: 'BAD' }).expect(
            400,
        );
        await get('/event-1/deliveries/delivery-1/attempts', 'admin', {
            limit: 101,
        }).expect(400);
        expect(f.db.notificationLog.findMany).not.toHaveBeenCalled();
    });

    it('strips unknown query properties in accordance with the application pipeline', async () => {
        const result = await get('', 'admin', {
            organizationId: 'foreign-org',
            unexpected: 'ignored',
        }).expect(200);
        expect(result.body.data.total).toBe(2);
        expect(
            f.db.alertEvent.findMany.mock.calls[0][0].where.organizationId,
        ).toBe('org');
    });

    it('exports all read routes with explicit Swagger response models', () => {
        const document = SwaggerModule.createDocument(
            app,
            new DocumentBuilder()
                .addBearerAuth(
                    { type: 'http', scheme: 'bearer' },
                    'access-token',
                )
                .build(),
        );
        const root = '/api/projects/{projectId}/monitoring/alert-events';
        for (const [path, entity] of [
            [root, 'AlertEventPageEntity'],
            [root + '/{eventId}', 'AlertEventDetailEntity'],
            [root + '/{eventId}/deliveries', 'EventDeliveryPageEntity'],
            [
                root + '/{eventId}/deliveries/{deliveryId}/attempts',
                'DeliveryAttemptPageEntity',
            ],
        ]) {
            expect(document.paths[path].get?.responses['200']).toMatchObject({
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/' + entity },
                    },
                },
            });
        }
        expect(
            document.components?.schemas?.AlertEventDetailEntity,
        ).toMatchObject({
            properties: {
                monitorDeleted: { type: 'boolean' },
                canRetryDeliveries: { type: 'boolean' },
            },
        });
    });
});
