import { ProjectAccessService } from '../../src/common/authorization/project-access.service';
import type { PrismaService } from '../../src/infra/database/prisma.service';

export const alertIds = {
    monitor: 'c123456789012345678901234',
    removedMonitor: 'c123456789012345678901235',
};

/** Persistence substitute only: HTTP tests use real JWT, project ACL and services. */
export function alertQueriesFixture() {
    const orgs = [
        { id: 'org', deletedAt: null },
        { id: 'foreign-org', deletedAt: null },
    ];
    const projects = [
        {
            id: 'project',
            organizationId: 'org',
            status: 'ACTIVE',
            deletedAt: null,
        },
        {
            id: 'sibling',
            organizationId: 'org',
            status: 'ACTIVE',
            deletedAt: null,
        },
        {
            id: 'foreign',
            organizationId: 'foreign-org',
            status: 'ACTIVE',
            deletedAt: null,
        },
    ];
    const events = [
        {
            id: 'event-1',
            organizationId: 'org',
            projectId: 'project',
            monitorId: alertIds.monitor,
            monitorName: 'API',
            target: 'https://user:target-password@api.test?access=target-token',
            kind: 'NO_DATA',
            level: 'warning',
            status: 'ongoing',
            origin: 'OBSERVED',
            reason: 'NO_EFFECTIVE_OBSERVATION',
            threshold: 600,
            actual: 700,
            unit: 's',
            suppressedReason: null,
            message: 'raw-private-diagnostic',
            latestEvidence: { details: { token: 'evidence-secret' } },
            startedAt: new Date('2026-10-29T01:00:00Z'),
            updatedAt: new Date('2026-10-29T01:10:00Z'),
            resolvedAt: null,
            durationSeconds: null,
            firstNotifiedAt: null,
        },
        {
            id: 'event-2',
            organizationId: 'org',
            projectId: 'project',
            monitorId: alertIds.removedMonitor,
            monitorName: 'Old API',
            target: 'https://old.test',
            kind: 'SSL',
            level: 'critical',
            status: 'resolved',
            origin: 'OBSERVED',
            reason: 'CERT_EXPIRED',
            threshold: 0,
            actual: -1,
            unit: 'd',
            suppressedReason: null,
            startedAt: new Date('2026-10-28T01:00:00Z'),
            updatedAt: new Date('2026-10-28T01:01:00Z'),
            resolvedAt: new Date('2026-10-28T01:01:00Z'),
            durationSeconds: 60,
            firstNotifiedAt: new Date('2026-10-28T01:00:01Z'),
        },
    ];
    events.push(
        { ...events[0], id: 'sibling-event', projectId: 'sibling' },
        {
            ...events[0],
            id: 'foreign-event',
            projectId: 'foreign',
            organizationId: 'foreign-org',
        },
    );
    const deliveries = [
        {
            id: 'delivery-1',
            eventId: 'event-1',
            channelId: 'channel-1',
            eventRevision: 1,
            phase: 'OPEN',
            status: 'FAILED',
            attempts: 3,
            createdAt: new Date('2026-10-29T01:00:00Z'),
            deliveredAt: null,
            nextAttemptAt: new Date('2026-10-29T01:01:00Z'),
            payload: { secret: 'payload-secret' },
            lastError: 'provider-secret',
            leaseToken: 'lease-secret',
        },
        {
            id: 'delivery-deleted-channel',
            eventId: 'event-1',
            channelId: 'deleted-channel',
            eventRevision: 1,
            phase: 'OPEN',
            status: 'SKIPPED',
            attempts: 0,
            createdAt: new Date('2026-10-29T01:00:01Z'),
            deliveredAt: null,
            nextAttemptAt: new Date('2026-10-29T01:01:00Z'),
        },
        {
            id: 'other-delivery',
            eventId: 'event-2',
            channelId: 'channel-1',
            eventRevision: 2,
            phase: 'RECOVERY',
            status: 'SUCCESS',
            attempts: 1,
            createdAt: new Date('2026-10-28T01:01:00Z'),
            deliveredAt: new Date('2026-10-28T01:01:01Z'),
            nextAttemptAt: new Date('2026-10-28T01:01:00Z'),
        },
    ];
    const logs = [1, 2, 3].map((attempt) => ({
        id: `log-${attempt}`,
        eventId: 'event-1',
        deliveryId: 'delivery-1',
        monitorId: alertIds.monitor,
        channelId: 'channel-1',
        attempt,
        phase: 'OPEN',
        status: 'FAILED',
        sentAt: new Date(`2026-10-29T01:00:0${attempt}Z`),
        error: 'log-secret',
    }));
    const channels = [
        {
            id: 'channel-1',
            organizationId: 'org',
            name: 'On-call email',
            type: 'EMAIL',
            enabled: true,
            config: {
                to: ['private@example.invalid'],
                token: 'channel-secret',
            },
        },
    ];
    const monitors = [
        {
            id: alertIds.monitor,
            projectId: 'project',
            organizationId: 'org',
            deletedAt: null,
        },
    ];
    const memberships = [
        'admin',
        'member',
        'viewer',
        'unassigned',
        'orgAdmin',
    ].map((userId) => ({
        id: `membership-${userId}`,
        userId,
        organizationId: 'org',
        role:
            userId === 'orgAdmin'
                ? 'ADMIN'
                : userId === 'viewer'
                  ? 'VIEWER'
                  : 'MEMBER',
    }));
    function matches(row: any, where: any = {}): boolean {
        return Object.entries(where).every(([key, expected]: [string, any]) => {
            if (expected === undefined) return true;
            const value = row?.[key];
            if (key === 'event')
                return matches(
                    events.find((e) => e.id === row.eventId),
                    expected,
                );
            if (
                expected === null ||
                typeof expected !== 'object' ||
                expected instanceof Date
            )
                return value === expected;
            return Object.entries(expected).every(
                ([op, operand]: [string, any]) => {
                    if (op === 'in') return operand.includes(value);
                    if (op === 'gte') return value >= operand;
                    if (op === 'lte') return value <= operand;
                    throw new Error(`Unsupported fixture filter: ${op}`);
                },
            );
        });
    }
    function pick(row: any, select: any) {
        return row && select
            ? Object.fromEntries(
                  Object.keys(select).map((key) => [key, row[key]]),
              )
            : row;
    }
    function delegate(rows: any[]) {
        const many = ({
            where,
            select,
            orderBy = [],
            skip = 0,
            take = rows.length,
        }: any = {}) =>
            rows
                .filter((row) => matches(row, where))
                .sort((a, b) => {
                    for (const sort of orderBy) {
                        const [key, direction] = Object.entries(sort)[0];
                        const left =
                            a[key] instanceof Date ? a[key].getTime() : a[key];
                        const right =
                            b[key] instanceof Date ? b[key].getTime() : b[key];
                        if (left !== right)
                            return (
                                (left > right ? 1 : -1) *
                                (direction === 'desc' ? -1 : 1)
                            );
                    }
                    return 0;
                })
                .slice(skip, skip + take)
                .map((row) => pick(row, select));
        return {
            findMany: jest.fn(many),
            findFirst: jest.fn((args) => many(args)[0] ?? null),
            count: jest.fn(
                ({ where }) => rows.filter((row) => matches(row, where)).length,
            ),
        };
    }
    const db: any = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        user: {
            findFirst: jest.fn(({ where }) => ({
                id: where.id,
                email: `${where.id}@example.invalid`,
                globalRole: where.id === 'super' ? 'SUPER_ADMIN' : 'USER',
                platformAuthorityVersion: 1,
            })),
        },
        organization: delegate(orgs),
        project: {
            findFirst: jest.fn(({ where, select }) =>
                pick(
                    projects.find(
                        (project) =>
                            project.id === where.id &&
                            (!where.organizationId ||
                                project.organizationId ===
                                    where.organizationId) &&
                            project.deletedAt === null &&
                            orgs.find((o) => o.id === project.organizationId)
                                ?.deletedAt === null,
                    ) ?? null,
                    select,
                ),
            ),
        },
        membership: {
            findUnique: jest.fn(
                ({ where }) =>
                    memberships.find(
                        (m) =>
                            m.userId === where.userId_organizationId.userId &&
                            m.organizationId ===
                                where.userId_organizationId.organizationId,
                    ) ?? null,
            ),
            findMany: jest.fn(({ where }) =>
                memberships.filter(
                    (m) =>
                        m.organizationId === where.organizationId &&
                        (typeof where.userId === 'string'
                            ? m.userId === where.userId
                            : where.userId.in.includes(m.userId)),
                ),
            ),
        },
        projectMembership: {
            findUnique: jest.fn(({ where }) => {
                const { membershipId, projectId } =
                    where.membershipId_projectId;
                const user = memberships.find(
                    (m) => m.id === membershipId,
                )?.userId;
                return projectId === 'project' &&
                    user &&
                    ['admin', 'member', 'viewer'].includes(user)
                    ? { organizationId: 'org', role: user.toUpperCase() }
                    : null;
            }),
        },
        monitor: delegate(monitors),
        notificationChannel: delegate(channels),
        notificationLog: delegate(logs),
        alertEvent: delegate(events),
        alertDelivery: {
            ...delegate(deliveries),
            updateMany: jest.fn(({ where, data }) => {
                const rows = deliveries.filter((d) => matches(d, where));
                rows.forEach((row) => Object.assign(row, data));
                return { count: rows.length };
            }),
            groupBy: jest.fn(({ where }) => {
                const counts = new Map<string, number>();
                deliveries
                    .filter((d) => matches(d, where))
                    .forEach((d) =>
                        counts.set(d.status, (counts.get(d.status) ?? 0) + 1),
                    );
                return [...counts].map(([status, count]) => ({
                    status,
                    _count: { _all: count },
                }));
            }),
        },
    };
    db.$transaction = jest.fn(async (work: (tx: any) => Promise<unknown>) =>
        work(db),
    );
    const access = new ProjectAccessService(db as PrismaService);
    return {
        db,
        access,
        events,
        deliveries,
        logs,
        channels,
        projects,
        orgs,
        memberships,
        monitors,
    };
}
