import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { StateController } from '../src/modules/state/state.controller';
import { StateService } from '../src/modules/state/state.service';
import { ProjectAccessService } from '../src/common/authorization/project-access.service';
import { ResourceContextResolver } from '../src/common/authorization/resource-context.resolver';
import { PrismaService } from '../src/infra/database/prisma.service';
import { fixture } from './fixtures/monitoring-lifecycle.fixture';
import { configureBusinessApp } from './fixtures/business-http.fixture';

describe('Monitoring lifecycle and HTTP state (offline)', () => {
    let app: INestApplication;
    let jwt: JwtService;
    let f: ReturnType<typeof fixture>;
    beforeEach(async () => {
        f = fixture();
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
        }).setSystemTime(f.now);
        const module = await Test.createTestingModule({
            controllers: [StateController],
            providers: [
                ResourceContextResolver,
                { provide: StateService, useValue: f.observations },
                { provide: ProjectAccessService, useValue: f.access },
                { provide: PrismaService, useValue: f.prisma },
            ],
        }).compile();
        app = module.createNestApplication();
        jwt = configureBusinessApp(app, f.prisma);
        await app.init();
    });
    afterEach(async () => {
        await app?.close();
        jest.useRealTimers();
    });
    function get(user = 'admin', project = 'project') {
        return request(app.getHttpServer())
            .get(`/api/projects/${project}/monitors/monitor/state`)
            .auth(jwt.sign({ sub: user }), { type: 'bearer' });
    }
    function observation(success: boolean, offset = 0) {
        jest.setSystemTime(Date.now() + 1000 + offset);
        return {
            revision: 1,
            configRevision: 1,
            checkedAt: new Date(),
            success,
            latency: 10,
        };
    }

    it('persists failure, sends through a controlled channel and exposes recovery over HTTP', async () => {
        await f.observations.record('monitor', observation(false));
        expect((await get().expect(200)).body.data.status).toBe('DOWN');
        expect(f.events).toHaveLength(1);
        expect(f.deliveries[0]).toMatchObject({
            phase: 'OPEN',
            status: 'PENDING',
        });
        await f.notifier.deliverAlertDelivery(f.deliveries[0].id);
        expect(f.deliveries[0].status).toBe('SUCCESS');
        await f.observations.record('monitor', observation(true, 1));
        expect((await get().expect(200)).body.data.status).toBe('UP');
        const recovery = f.deliveries.find((row) => row.phase === 'RECOVERY');
        await f.notifier.deliverAlertDelivery(recovery.id);
        expect(recovery.status).toBe('SUCCESS');
        expect(f.sentLogs.map((log) => log.status)).toEqual([
            'SUCCESS',
            'SUCCESS',
        ]);
        expect(f.sender.send).toHaveBeenCalledTimes(2);
    });

    it('marks NO_DATA once, rejects old recovery and retains independent SSL evidence', async () => {
        const now = new Date();
        await f.sweep.mark('monitor', now);
        await f.sweep.mark('monitor', now);
        expect((await get().expect(200)).body.data).toMatchObject({
            status: 'UNKNOWN',
            executionBlockedReason: 'NO_DATA',
        });
        expect(f.events.filter((e) => e.kind === 'NO_DATA')).toHaveLength(1);
        await f.notifier.deliverAlertDelivery(f.deliveries[0].id);
        await f.observations.record('monitor', {
            ...observation(true),
            checkedAt: new Date(+now - 1000),
        });
        expect((await get().expect(200)).body.data.status).toBe('UNKNOWN');
        f.monitor.checkSsl = true;
        await f.observations.record('monitor', {
            ...observation(false, 1),
            serviceVerdict: 'NO_EVIDENCE',
            sslVerdict: 'INVALID',
        });
        expect(f.events.find((e) => e.kind === 'SSL')).toMatchObject({
            reason: 'SSL_INVALID',
            status: 'ongoing',
        });
        expect(f.state.noDataSince).toEqual(now);
        await f.observations.record('monitor', observation(true, 2));
        expect((await get().expect(200)).body.data.status).toBe('UP');
        const recovery = f.deliveries.find(
            (d) => d.payload.event === 'NO_DATA_RECOVERED',
        );
        await f.notifier.deliverAlertDelivery(recovery.id);
        expect(recovery.status).toBe('SUCCESS');
    });

    it('rolls back state, history and events if a delivery intent cannot persist', async () => {
        f.prisma.alertDelivery.create.mockRejectedValueOnce(
            new Error('write unavailable'),
        );
        await expect(
            f.observations.record('monitor', observation(false)),
        ).rejects.toThrow('write unavailable');
        expect(f.state.status).toBe('UP');
        expect(f.events).toHaveLength(0);
        expect(f.logs.size).toBe(0);
        expect((await get().expect(200)).body.data.status).toBe('UP');
    });

    it('requires authentication and denies cross-project or outsider reads', async () => {
        await request(app.getHttpServer())
            .get('/api/projects/project/monitors/monitor/state')
            .expect(401);
        await get('outsider').expect(404);
        await get('admin', 'foreign-project').expect(404);
    });
});
