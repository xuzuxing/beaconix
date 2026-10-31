import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/infra/database/prisma.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { AdminAlertDeliveriesController } from '../src/modules/admin/alert-deliveries/admin-alert-deliveries.controller';
import { AdminAlertDeliveriesService } from '../src/modules/admin/alert-deliveries/admin-alert-deliveries.service';
import { AdminMetricsController } from '../src/modules/admin/metrics/admin-metrics.controller';
import { AdminMetricsService } from '../src/modules/admin/metrics/admin-metrics.service';

describe('Admin failed alert deliveries HTTP (offline)', () => {
    let app: INestApplication;
    let db: any;
    let jwt: JwtService;
    let queue: { getJobCounts: jest.Mock; getJobSchedulers: jest.Mock };
    const orgId = 'c123456789012345678901234';
    const projectId = 'c123456789012345678901235';

    beforeEach(async () => {
        const row = {
            id: 'delivery',
            status: 'FAILED',
            attempts: 3,
            phase: 'OPEN',
            channelId: 'channel',
            payload: { secret: 'never-return-this' },
            lastError: 'https://robot.test?token=secret',
            event: {
                organizationId: orgId,
                projectId,
                monitorId: 'monitor',
                kind: 'NO_DATA',
            },
        };
        db = {
            monitor: { count: jest.fn().mockResolvedValue(1) },
            probe: { groupBy: jest.fn().mockResolvedValue([]) },
            $queryRaw: jest.fn().mockResolvedValue([{ count: 1 }]),
            user: {
                findFirst: jest.fn(({ where }) => ({
                    id: where.id,
                    email: `${where.id}@test.local`,
                    globalRole: where.id === 'admin' ? 'SUPER_ADMIN' : 'USER',
                })),
            },
            alertDelivery: {
                findMany: jest.fn(({ where, select, skip, take }) => {
                    if (
                        where.status !== row.status ||
                        (where.event.organizationId &&
                            where.event.organizationId !== orgId)
                    )
                        return [];
                    return [
                        Object.fromEntries(
                            Object.keys(select).map((key) => [key, row[key]]),
                        ),
                    ].slice(skip, skip + take);
                }),
                count: jest.fn(({ where }) =>
                    where.status === row.status &&
                    (!where.event.organizationId ||
                        where.event.organizationId === orgId)
                        ? 1
                        : 0,
                ),
            },
        };
        jwt = new JwtService({ secret: 'offline-monitoring-reliability' });
        queue = {
            getJobCounts: jest.fn().mockResolvedValue({ waiting: 1 }),
            getJobSchedulers: jest.fn().mockResolvedValue([]),
        };
        const module = await Test.createTestingModule({
            controllers: [
                AdminAlertDeliveriesController,
                AdminMetricsController,
            ],
            providers: [
                AdminAlertDeliveriesService,
                {
                    provide: AdminMetricsService,
                    useValue: new AdminMetricsService(
                        db,
                        queue as never,
                        queue as never,
                        queue as never,
                    ),
                },
                { provide: PrismaService, useValue: db },
            ],
        }).compile();
        app = module.createNestApplication();
        app.setGlobalPrefix('api');
        app.useGlobalPipes(
            new ValidationPipe({
                transform: true,
                whitelist: true,
                forbidNonWhitelisted: true,
            }),
        );
        app.useGlobalGuards(new JwtAuthGuard(jwt, new Reflector(), db));
        app.useGlobalInterceptors(new TransformInterceptor());
        await app.init();
    });
    afterEach(async () => app?.close());

    function query(
        q: Record<string, string | number | undefined> = {},
        user = 'admin',
    ) {
        return request(app.getHttpServer())
            .get('/api/admin/alert-deliveries')
            .auth(jwt.sign({ sub: user }), { type: 'bearer' })
            .query(q);
    }

    it('requires authentication and a current SUPER_ADMIN role', async () => {
        await request(app.getHttpServer())
            .get('/api/admin/alert-deliveries')
            .expect(401);
        await query({}, 'member').expect(403);
        expect(db.alertDelivery.findMany).not.toHaveBeenCalled();
    });

    it('protects scheduler health and exposes dependency outages as unavailable', async () => {
        const health = (user = 'admin') =>
            request(app.getHttpServer())
                .get('/api/admin/metrics/scheduler')
                .auth(jwt.sign({ sub: user }), { type: 'bearer' });
        await request(app.getHttpServer())
            .get('/api/admin/metrics/scheduler')
            .expect(401);
        await health('member').expect(403);
        expect(queue.getJobCounts).not.toHaveBeenCalled();
        const ready = await health().expect(200);
        expect(ready.body.data).toMatchObject({
            scanQueue: { waiting: 1 },
            backlog: { dueMonitors: 1 },
        });
        queue.getJobCounts.mockRejectedValue(
            new Error('redis://private-secret@internal'),
        );
        const down = await health().expect(503);
        expect(down.body.message).toBe('Scheduler health unavailable');
        expect(JSON.stringify(down.body)).not.toMatch(
            /private-secret|internal/,
        );
        queue.getJobCounts.mockResolvedValue({ waiting: 0 });
        expect((await health().expect(200)).body.data.scanQueue.waiting).toBe(
            0,
        );
    });

    it('defaults to FAILED, applies tenant filters, and excludes raw secrets', async () => {
        const response = await query({
            organizationId: orgId,
            limit: 1,
        }).expect(200);
        expect(response.body.data).toMatchObject({
            total: 1,
            page: 1,
            limit: 1,
            items: [
                { status: 'FAILED', event: { projectId, kind: 'NO_DATA' } },
            ],
        });
        expect(JSON.stringify(response.body)).not.toMatch(
            /never-return-this|token=secret|payload|lastError/,
        );
        const empty = await query({
            organizationId: 'c123456789012345678901239',
        }).expect(200);
        expect(empty.body.data.total).toBe(0);
        expect(empty.body.data.items).toEqual([]);
        expect(
            (await query({ page: 2, limit: 1 }).expect(200)).body.data.items,
        ).toEqual([]);
    });

    it.each([
        { status: 'BOGUS' },
        { limit: 101 },
        { page: 0 },
        { organizationId: 'bad-id' },
        { phase: 'BOGUS' },
        { from: 'invalid' },
        { unknown: 'property' },
        { from: '2026-10-31', to: '2026-10-30' },
    ])('rejects invalid query %j', async (q) => {
        await query(q).expect(400);
        expect(db.alertDelivery.findMany).not.toHaveBeenCalled();
    });
});
