import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { MonitorCapacityController } from '../src/modules/billing/subscription/monitor-capacity.controller';
import { BillingMonitorCapacityService } from '../src/modules/billing/subscription/monitor-capacity.service';
import { PrismaService } from '../src/infra/database/prisma.service';
import { EffectivePlanService } from '../src/shared/subscription/effective-plan.service';
import { MonitorCapacityService } from '../src/shared/subscription/monitor-capacity.service';
import { ProjectAccessService } from '../src/common/authorization/project-access.service';
import { StateService } from '../src/modules/state/state.service';
import { configureBusinessApp } from './fixtures/business-http.fixture';
import {
    httpFixture,
    START,
    HOUR,
} from './fixtures/subscription-capacity.fixture';

describe('Subscription capacity HTTP lifecycle (offline)', () => {
    let app: INestApplication;
    let jwt: JwtService;
    let f: ReturnType<typeof httpFixture>;
    let at: Date;
    beforeEach(async () => {
        f = httpFixture();
        at = START;
        jest.useFakeTimers({
            doNotFake: [
                'hrtime',
                'nextTick',
                'performance',
                'queueMicrotask',
                'setImmediate',
                'clearImmediate',
                'setInterval',
                'clearInterval',
                'setTimeout',
                'clearTimeout',
            ],
        }).setSystemTime(at);
        const module = await Test.createTestingModule({
            controllers: [MonitorCapacityController],
            providers: [
                BillingMonitorCapacityService,
                { provide: PrismaService, useValue: f.tx },
                { provide: EffectivePlanService, useValue: f.plans },
                { provide: MonitorCapacityService, useValue: f.service },
                { provide: ProjectAccessService, useValue: f.access },
            ],
        }).compile();
        app = module.createNestApplication();
        jwt = configureBusinessApp(app, f.tx);
        await app.init();
    });
    afterEach(async () => {
        await app?.close();
        jest.useRealTimers();
    });
    function get(user = 'admin', org = 'org') {
        jest.setSystemTime(at);
        return request(app.getHttpServer())
            .get(`/api/organizations/${org}/subscription/monitor-capacity`)
            .auth(jwt.sign({ sub: user }), { type: 'bearer' });
    }

    it('enforces the 72-hour deadline, persists idempotent email intent, then restores without unpausing', async () => {
        let response = await get().expect(200);
        expect(response.body.data).toMatchObject({
            status: 'GRACE',
            total: 3,
            limit: 1,
            retainedMonitorIds: ['a'],
        });
        const deadline = new Date(+START + 72 * HOUR);
        expect(response.body.data.graceEndsAt).toBe(deadline.toISOString());
        await get().expect(200);
        expect(f.intents).toHaveLength(1);
        expect(f.intents[0]).toMatchObject({
            email: true,
            type: 'MONITOR_CAPACITY_GRACE_STARTED',
        });
        at = new Date(+deadline - 1);
        expect((await get().expect(200)).body.data.status).toBe('GRACE');
        at = deadline;
        response = await get().expect(200);
        expect(response.body.data).toMatchObject({
            status: 'LIMITED',
            restrictedMonitorIds: ['b', 'c'],
        });
        const count = f.intents.length;
        await get().expect(200);
        expect(f.intents).toHaveLength(count);
        f.renew();
        response = await get().expect(200);
        expect(response.body.data).toMatchObject({
            status: 'WITHIN_LIMIT',
            limit: 10,
        });
        expect(f.monitors[1]).toMatchObject({
            enabled: true,
            quotaGraceEndsAt: null,
            revision: 2,
        });
        expect(f.monitors[2]).toMatchObject({
            enabled: false,
            quotaGraceEndsAt: null,
        });
        // Real state service must fence a result captured before restoration.
        const state = new StateService(f.tx, {} as never, f.access);
        expect(
            await state.record('b', {
                revision: 1,
                configRevision: 1,
                success: true,
                latency: 1,
            }),
        ).toBeNull();
        expect(
            f.intents.some((row) => row.type === 'MONITOR_CAPACITY_RESTORED'),
        ).toBe(true);
    });

    it('rolls back deadline, cycle and email intent together when persistence fails', async () => {
        f.failNotice();
        await get().expect(500);
        expect(f.org.monitorCapacityPlanId).toBe('pro');
        expect(f.cycles).toHaveLength(0);
        expect(f.intents).toHaveLength(0);
        expect(f.monitors.every((m) => m.quotaGraceEndsAt === null)).toBe(true);
    });

    it('changes retained monitors through HTTP without extending grace and rejects stale cycles', async () => {
        f.monitors.forEach((m, i) => {
            m.id = `c${(i + 1).toString().padStart(24, '0')}`;
        });
        const current = (await get().expect(200)).body.data;
        const patch = (cycleId: string, monitorIds: string[]) =>
            request(app.getHttpServer())
                .patch('/api/organizations/org/subscription/monitor-capacity')
                .auth(jwt.sign({ sub: 'admin' }), { type: 'bearer' })
                .send({ cycleId, monitorIds });
        const selected = await patch(current.cycleId, [
            f.monitors[1].id,
        ]).expect(200);
        expect(selected.body.data.retainedMonitorIds).toEqual([
            f.monitors[1].id,
        ]);
        expect(selected.body.data.graceEndsAt).toBe(current.graceEndsAt);
        await patch('c999999999999999999999999', []).expect(400);
        await patch(current.cycleId, ['c999999999999999999999999']).expect(400);
        expect((await get().expect(200)).body.data.retainedMonitorIds).toEqual([
            f.monitors[1].id,
        ]);
    });

    it('rejects unauthenticated, member and cross-organization requests before mutating capacity', async () => {
        await request(app.getHttpServer())
            .get('/api/organizations/org/subscription/monitor-capacity')
            .expect(401);
        await get('member').expect(403);
        await get('outsider').expect(403);
        await get('admin', 'other-org').expect(404);
        expect(f.cycles).toHaveLength(0);
        expect(f.intents).toHaveLength(0);
    });
});
