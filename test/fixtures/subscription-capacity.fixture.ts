import { ConfigService } from '@nestjs/config';
import { MonitorCapacityService } from '../../src/shared/subscription/monitor-capacity.service';
import { EffectivePlanService } from '../../src/shared/subscription/effective-plan.service';
import { ProjectAccessService } from '../../src/common/authorization/project-access.service';
import { identityTables, transactions } from './business-http.fixture';

export const START = new Date('2026-10-20T00:00:00Z');
export const HOUR = 3600000;
export const free = { id: 'free', name: 'Free', maxMonitors: 1, sortOrder: 0 };
export const pro = { id: 'pro', name: 'Pro', maxMonitors: 10, sortOrder: 2 };

export function fixture() {
    const org = {
        id: 'org',
        monitorCapacityPlanId: 'pro',
        monitorCapacityLimit: 10,
        monitorCapacityObservedAt: new Date(START.getTime() - HOUR),
    };
    const monitors = ['a', 'b', 'c'].map((id) => ({
        id,
        enabled: id !== 'c',
        quotaGraceEndsAt: null as Date | null,
        revision: 1,
        configRevision: 1,
    }));
    const cycles: any[] = [];
    const tx: any = {
        organization: {
            findFirst: jest.fn(() => org),
            update: jest.fn(({ data }) => Object.assign(org, data)),
        },
        monitor: {
            findMany: jest.fn(() => monitors),
            count: jest.fn(
                ({ where }) =>
                    where.id.in.filter((id) =>
                        monitors.some((m) => m.id === id),
                    ).length,
            ),
            updateMany: jest.fn(({ where, data }) => {
                for (const m of monitors.filter((m) =>
                    where.id.in.includes(m.id),
                )) {
                    if ('quotaGraceEndsAt' in data)
                        m.quotaGraceEndsAt = data.quotaGraceEndsAt;
                    if (data.revision) m.revision += data.revision.increment;
                    if (data.configRevision)
                        m.configRevision += data.configRevision.increment;
                }
                return { count: where.id.in.length };
            }),
        },
        plan: { findUnique: jest.fn(() => free) },
        subscription: {
            findMany: jest.fn(() => []),
            findFirst: jest.fn(() => ({
                id: 'subscription',
                planId: 'pro',
                plan: pro,
                expiresAt: START,
                order: { userId: 'payer' },
            })),
        },
        monitorState: { updateMany: jest.fn(() => ({ count: 1 })) },
        monitorCapacityCycle: {
            findFirst: jest.fn(
                ({ where }) =>
                    cycles.find(
                        (c) =>
                            c.organizationId === where.organizationId &&
                            (!where.id || c.id === where.id) &&
                            where.status.in.includes(c.status),
                    ) ?? null,
            ),
            upsert: jest.fn(({ where, create }) => {
                let c = cycles.find((c) => c.sourceKey === where.sourceKey);
                if (!c) {
                    c = {
                        id: `c${cycles.length.toString().padStart(24, '0')}`,
                        status: 'GRACE',
                        selectedMonitorIds: [],
                        retainedMonitorIds: [],
                        restrictedMonitorIds: [],
                        announcedAt: null,
                        warnedAt: null,
                        ...create,
                    };
                    cycles.push(c);
                }
                return c;
            }),
            update: jest.fn(({ where, data }) =>
                Object.assign(
                    cycles.find((c) => c.id === where.id),
                    data,
                ),
            ),
        },
    };
    const notices = {
        organizationRecipients: jest.fn(() => ['owner', 'admin']),
        publish: jest.fn<undefined, any[]>(() => undefined),
    };
    const service = new MonitorCapacityService(
        tx,
        notices as never,
        new ConfigService({ app: { webUrl: 'https://beacon.example' } }),
    );
    return { service, tx, org, monitors, cycles, notices };
}

export function httpFixture() {
    const f = fixture();
    const { tx, org, monitors, cycles, notices } = f;
    const identities = identityTables(org);
    Object.assign(tx, identities);
    tx.organization.update = jest.fn(({ data }) => Object.assign(org, data));
    tx.$queryRaw = jest.fn().mockResolvedValue([]);
    monitors.forEach((m) =>
        Object.assign(m, {
            projectId: 'project',
            organizationId: 'org',
            deletedAt: null,
        }),
    );
    tx.monitor.findFirst = jest.fn(
        ({ where }) => monitors.find((m) => m.id === where.id) ?? null,
    );
    tx.monitor.count = jest.fn(
        ({ where }) =>
            monitors.filter((m) => !where.id || where.id.in.includes(m.id))
                .length,
    );
    tx.monitor.findMany = jest.fn(({ where }) =>
        monitors.filter(
            (m) => !where.quotaGraceEndsAt || m.quotaGraceEndsAt !== null,
        ),
    );
    let paid = false;
    tx.subscription.findFirst = jest.fn(({ where }) => {
        if (where.status === 'PAUSED') return null;
        if (where.expiresAt?.gt)
            return paid ? { id: 'renewed', planId: 'pro', plan: pro } : null;
        return {
            id: 'expired-pro',
            planId: 'pro',
            plan: pro,
            expiresAt: START,
            order: { userId: 'payer' },
        };
    });
    const intents: any[] = [];
    let failNotice = false;
    notices.publish.mockImplementation((input: any) => {
        if (failNotice) throw new Error('outbox unavailable');
        if (!intents.some((row) => row.eventKey === input.eventKey))
            intents.push(structuredClone(input));
        return undefined;
    });
    transactions(
        tx,
        () => ({ org, monitors, cycles, intents }),
        (saved) => {
            Object.assign(org, saved.org);
            monitors.forEach((m, i) => Object.assign(m, saved.monitors[i]));
            cycles.splice(0, cycles.length, ...saved.cycles);
            intents.splice(0, intents.length, ...saved.intents);
        },
    );
    return {
        ...f,
        intents,
        plans: new EffectivePlanService(tx, f.service),
        access: new ProjectAccessService(tx),
        renew: () => {
            paid = true;
        },
        failNotice: () => {
            failNotice = true;
        },
    };
}
