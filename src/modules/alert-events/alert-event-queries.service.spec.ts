import {
    alertQueriesFixture,
    alertIds,
} from '../../../test/fixtures/alert-event-queries.fixture';
import { AlertEventQueriesService } from './alert-event-queries.service';
import {
    AlertPageDto,
    QueryAlertEventsDto,
    QueryEventDeliveriesDto,
} from './dto/query-alert-events.dto';

describe('Alert event queries: persistence and authorization boundaries', () => {
    const principal = { type: 'USER' as const, userId: 'admin' };
    function fixture() {
        const f = alertQueriesFixture();
        return { ...f, service: new AlertEventQueriesService(f.db, f.access) };
    }

    it('reauthorizes a direct service call within the same repeatable-read snapshot as rows and count', async () => {
        const f = fixture();
        const authorize = jest.spyOn(f.access, 'project');
        await f.service.findAll(
            'project',
            new QueryAlertEventsDto(),
            principal,
        );
        expect(authorize).toHaveBeenCalledWith(
            principal,
            'project',
            'monitoring.read',
            undefined,
            f.db,
        );
        expect(f.db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
            isolationLevel: 'RepeatableRead',
            timeout: 10000,
        });
        const find = f.db.alertEvent.findMany.mock.calls[0][0];
        const count = f.db.alertEvent.count.mock.calls[0][0];
        expect(find.where).toEqual(count.where);
        expect(find.where).toMatchObject({
            projectId: 'project',
            organizationId: 'org',
        });
        expect(find.orderBy).toEqual([{ startedAt: 'desc' }, { id: 'desc' }]);
        expect(find.select).not.toHaveProperty('message');
        expect(find.select).not.toHaveProperty('latestEvidence');
    });

    it('does not rely on a previous successful guard decision after membership is removed', async () => {
        const f = fixture();
        await f.access.project(principal, 'project', 'monitoring.read');
        f.memberships.splice(
            f.memberships.findIndex((m) => m.userId === 'admin'),
            1,
        );
        await expect(
            f.service.findOne('project', 'event-1', principal),
        ).rejects.toThrow('Organization not found');
        expect(f.db.alertEvent.findFirst).not.toHaveBeenCalled();
    });

    it('limits details to both the authorized project and organization even with a known event ID', async () => {
        const f = fixture();
        await expect(
            f.service.findOne('project', 'foreign-event', principal),
        ).rejects.toThrow('Alert event not found');
        expect(f.db.alertEvent.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    id: 'foreign-event',
                    projectId: 'project',
                    organizationId: 'org',
                },
            }),
        );
        expect(f.db.alertDelivery.groupBy).not.toHaveBeenCalled();
    });

    it('keeps an empty page empty without broadening monitor or channel queries', async () => {
        const f = fixture();
        const page = Object.assign(new QueryAlertEventsDto(), {
            page: 3,
            limit: 1,
        });
        expect(
            (await f.service.findAll('project', page, principal)).items,
        ).toEqual([]);
        expect(f.db.monitor.findMany).not.toHaveBeenCalled();
        const deliveries = Object.assign(new QueryEventDeliveriesDto(), {
            status: 'PENDING',
        });
        expect(
            (
                await f.service.deliveries(
                    'project',
                    'event-1',
                    deliveries,
                    principal,
                )
            ).total,
        ).toBe(0);
        expect(f.db.notificationChannel.findMany).not.toHaveBeenCalled();
    });

    it('excludes orphaned or mismatched attempt logs instead of trusting deliveryId alone', async () => {
        const f = fixture();
        f.logs.push(
            { ...f.logs[0], id: 'wrong-event', eventId: 'foreign-event' },
            { ...f.logs[0], id: 'wrong-channel', channelId: 'foreign-channel' },
        );
        const result = await f.service.attempts(
            'project',
            'event-1',
            'delivery-1',
            new AlertPageDto(),
            principal,
        );
        expect(result.total).toBe(3);
        expect(f.db.notificationLog.findMany.mock.calls[0][0].where).toEqual({
            deliveryId: 'delivery-1',
            eventId: 'event-1',
            monitorId: alertIds.monitor,
            channelId: 'channel-1',
        });
        expect(result.items.map((row) => row.id)).toEqual([
            'log-3',
            'log-2',
            'log-1',
        ]);
        expect(
            f.db.notificationLog.findMany.mock.calls[0][0].select,
        ).not.toHaveProperty('error');
    });

    it('batches current channel lookups and restricts them to the authorized tenant', async () => {
        const f = fixture();
        await f.service.deliveries(
            'project',
            'event-1',
            new QueryEventDeliveriesDto(),
            principal,
        );
        expect(f.db.notificationChannel.findMany).toHaveBeenCalledTimes(1);
        expect(f.db.notificationChannel.findMany).toHaveBeenCalledWith({
            where: {
                organizationId: 'org',
                id: { in: ['channel-1', 'deleted-channel'] },
            },
            select: { id: true, name: true, type: true, enabled: true },
        });
    });

    it('rejects unparseable ISO dates before querying persistence, including direct calls', () => {
        const f = fixture();
        for (const from of ['2026-W44-5', '2026-303']) {
            expect(() =>
                f.service.findAll(
                    'project',
                    Object.assign(new QueryAlertEventsDto(), { from }),
                    principal,
                ),
            ).toThrow('parseable calendar dates');
        }
        expect(f.db.$transaction).not.toHaveBeenCalled();
    });
});
