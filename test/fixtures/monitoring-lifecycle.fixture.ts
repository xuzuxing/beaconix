import { MonitorNoDataService } from '../../src/modules/alert-events/monitor-no-data.service';
import { AlertEventsService } from '../../src/modules/alert-events/alert-events.service';
import { StateService } from '../../src/modules/state/state.service';
import { identityTables, transactions } from './business-http.fixture';
import { ProjectAccessService } from '../../src/common/authorization/project-access.service';
import { NotifierService } from '../../src/modules/notifier/notifier.service';

export function fixture() {
    const now = new Date('2026-10-30T04:00:00Z');
    let state: any = {
        status: 'UP',
        failCount: 0,
        connectivityFailCount: 0,
        lastEffectiveObservationAt: new Date(now.getTime() - 600000),
        lastAppliedObservationAt: new Date(now.getTime() - 600000),
        lastCheckAt: new Date(now.getTime() - 600000),
        noDataSince: null,
    };
    const monitor: any = {
        id: 'monitor',
        name: 'API',
        target: 'https://example.test',
        type: 'HTTP',
        projectId: 'project',
        organizationId: 'org',
        enabled: true,
        interval: 60,
        failureThreshold: 1,
        configRevision: 1,
        revision: 1,
        deletedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
    };
    const events: any[] = [];
    const deliveries: any[] = [];
    const logs = new Map<string, any>();
    const sentLogs: any[] = [];
    const prisma: any = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        $transaction: jest.fn((work) => work(prisma)),
        ...identityTables({ id: 'org', deletedAt: null }),
        monitor: {
            findFirst: jest.fn(({ where }) =>
                where.id === monitor.id &&
                (!where.projectId || where.projectId === monitor.projectId)
                    ? { ...monitor, state }
                    : null,
            ),
        },
        monitorState: {
            upsert: jest.fn(({ update, create }) => {
                state = {
                    ...state,
                    ...Object.fromEntries(
                        Object.entries(state ? update : create).filter(
                            ([, v]) => v !== undefined,
                        ),
                    ),
                };
                return { ...state };
            }),
        },
        checkLog: {
            count: jest.fn(
                ({ where }) =>
                    [...logs.values()].filter(
                        (log) =>
                            (!where.evaluated || log.evaluated) &&
                            (!where.success || log.success),
                    ).length,
            ),
            aggregate: jest.fn(() => ({ _avg: { latency: 10 } })),
            findUnique: jest.fn(({ where }) =>
                logs.get(
                    where.observationId ?? where.monitorId_roundId?.roundId,
                ),
            ),
            create: jest.fn(({ data }) => {
                logs.set(data.observationId, data);
                return data;
            }),
            update: jest.fn(({ data }) => data),
            updateMany: jest.fn(),
        },
        alertEvent: {
            updateMany: jest.fn(({ where, data }) => {
                const rows = events.filter(
                    (event) =>
                        event.id === where.id &&
                        (!('firstNotifiedAt' in where) ||
                            !event.firstNotifiedAt),
                );
                rows.forEach((event) => Object.assign(event, data));
                return { count: rows.length };
            }),
            findFirst: jest.fn(({ where }) =>
                events.find(
                    (event) =>
                        event.kind === where.kind &&
                        event.status === where.status,
                ),
            ),
            create: jest.fn(({ data }) => {
                const event = {
                    id: `event-${events.length}`,
                    status: 'ongoing',
                    lifecycleRevision: 1,
                    ...data,
                };
                events.push(event);
                return event;
            }),
            update: jest.fn(({ where, data }) => {
                const event = events.find((event) => event.id === where.id);
                const revision = event.lifecycleRevision;
                Object.assign(event, data);
                if (data.lifecycleRevision)
                    event.lifecycleRevision = revision + 1;
                return event;
            }),
        },
        alertDelivery: {
            findUnique: jest.fn(({ where }) => {
                const row = deliveries.find((d) => d.id === where.id);
                return row
                    ? {
                          ...row,
                          event: events.find((e) => e.id === row.eventId),
                      }
                    : null;
            }),
            findFirst: jest.fn(({ where }) =>
                deliveries.find((d) =>
                    Object.entries(where).every(
                        ([key, value]) => d[key] === value,
                    ),
                ),
            ),
            update: jest.fn(({ where, data }) => {
                const row = deliveries.find((d) => d.id === where.id);
                const increment = data.attempts?.increment;
                const attempts = row.attempts;
                Object.assign(row, data);
                if (increment) row.attempts = attempts + increment;
                return row;
            }),
            updateMany: jest.fn(async ({ where, data }) => {
                const rows = deliveries.filter((d) =>
                    Object.entries(where).every(([key, value]) =>
                        value &&
                        typeof value === 'object' &&
                        'gt' in value &&
                        value.gt instanceof Date
                            ? d[key] > value.gt
                            : d[key] === value,
                    ),
                );
                for (const row of rows)
                    await prisma.alertDelivery.update({
                        where: { id: row.id },
                        data,
                    });
                return { count: rows.length };
            }),
            findMany: jest.fn(({ where }) =>
                deliveries.filter(
                    (d) =>
                        d.eventId === where.eventId && d.phase === where.phase,
                ),
            ),
            create: jest.fn(({ data }) => {
                const row = {
                    id: `delivery-${deliveries.length}`,
                    status: 'PENDING',
                    attempts: 0,
                    nextAttemptAt: new Date(),
                    ...data,
                };
                deliveries.push(row);
                return row;
            }),
        },
        monitorNotificationChannel: {
            findMany: jest.fn().mockResolvedValue([]),
        },
        notificationChannel: {
            findMany: jest.fn().mockResolvedValue([{ id: 'channel' }]),
            findFirst: jest.fn(() => ({
                id: 'channel',
                type: 'FEISHU',
                enabled: true,
            })),
        },
        notificationLog: {
            create: jest.fn(({ data }) => {
                sentLogs.push(data);
                return data;
            }),
        },
    };
    const notifications = {
        organizationRecipients: jest.fn().mockResolvedValue(['owner']),
        eventRecipients: jest.fn().mockResolvedValue(['owner']),
        publish: jest.fn(),
    };
    const registry = { register: jest.fn() };
    transactions(
        prisma,
        () => ({ state, events, deliveries, logs, sentLogs }),
        (saved) => {
            state = saved.state;
            events.splice(0, events.length, ...saved.events);
            deliveries.splice(0, deliveries.length, ...saved.deliveries);
            logs.clear();
            saved.logs.forEach((value, key) => logs.set(key, value));
            sentLogs.splice(0, sentLogs.length, ...saved.sentLogs);
        },
    );
    const access = new ProjectAccessService(prisma);
    const sender = { send: jest.fn().mockResolvedValue(undefined) };
    const alerts = new AlertEventsService(
        prisma,
        notifications as never,
        access,
    );
    return {
        now,
        monitor,
        events,
        deliveries,
        logs,
        sender,
        sentLogs,
        access,
        notifier: new NotifierService(
            prisma,
            sender as never,
            sender as never,
            sender as never,
            sender as never,
            sender as never,
            {} as never,
        ),
        notifications,
        prisma,
        registry,
        get state() {
            return state;
        },
        sweep: new MonitorNoDataService(prisma, alerts, registry as never),
        observations: new StateService(prisma, alerts, access),
    };
}
