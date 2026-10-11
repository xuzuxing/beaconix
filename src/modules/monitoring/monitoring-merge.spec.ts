import { Prisma } from '../../generated/prisma/client';
import { MonitorType } from '../../generated/prisma/enums';
import { MonitoringDashboardService } from './monitoring-dashboard.service';
import { MonitorInsightsService } from './monitor-insights.service';
import {
    QueryMonitoringAvailabilityDto,
    QueryMonitoringDashboardDto,
    QueryMonitoringStatusCodesDto,
} from './dto/query-monitoring.dto';
import { QueryMonitorInsightsDto } from './dto/query-monitor-insights.dto';

function fixture() {
    const asOf = new Date('2026-10-11T12:00:00Z');
    const since = new Date('2026-10-01T00:00:00Z');
    const monitors = [MonitorType.HTTP, MonitorType.DNS, MonitorType.REDIS].map(
        (type) => ({
            id: type,
            type,
            name: type,
            target: 'example.test',
            createdAt: since,
            enabled: true,
            checkSsl: false,
            state: { status: 'UP' },
        }),
    );
    const queries: string[] = [];
    const tx = {
        $executeRaw: jest.fn(),
        $queryRaw: jest.fn(
            (strings: TemplateStringsArray, ...values: unknown[]) => {
                const sql = Prisma.sql(strings, ...values).sql;
                queries.push(sql);
                if (sql.includes('clock_timestamp')) return [{ at: asOf }];
                if (sql.includes('FROM check_logs')) {
                    expect(sql).toMatch(/(?:c\.)?evaluated = true/);
                    if (!sql.includes('GROUP BY'))
                        return [
                            {
                                checks: 1,
                                failures: 0,
                                rescued: 0,
                                avg: 20,
                                p50: 20,
                                p95: 20,
                                p99: 20,
                            },
                        ];
                }
                return [];
            },
        ),
        monitor: {
            findMany: jest.fn().mockResolvedValue(monitors),
            findFirst: jest.fn().mockResolvedValue(monitors[0]),
        },
        monitoringCoverage: {
            findUniqueOrThrow: jest.fn().mockResolvedValue({
                checksStartedAt: since,
                countsStartedAt: since,
                probeStartedAt: since,
                alertsStartedAt: since,
            }),
        },
        monitorHistory: { count: jest.fn().mockResolvedValue(0) },
        probe: { findMany: jest.fn().mockResolvedValue([]) },
        probeResult: {
            groupBy: jest.fn().mockResolvedValue([]),
            count: jest.fn().mockResolvedValue(0),
        },
        alertEvent: {
            findMany: jest.fn().mockResolvedValue([]),
            count: jest.fn().mockResolvedValue(0),
        },
        checkLog: {
            findMany: jest.fn().mockResolvedValue([]),
            count: jest.fn().mockResolvedValue(0),
        },
    };
    const prisma = {
        ...tx,
        project: { findFirst: jest.fn().mockResolvedValue({ id: 'project' }) },
        $transaction: jest.fn((callback: (value: typeof tx) => unknown) =>
            callback(tx),
        ),
    };
    const cache = { getOrSet: (_key: string, build: () => unknown) => build() };
    const probes = {
        getAssignmentsForMonitors: jest.fn().mockResolvedValue([]),
    };
    return {
        tx,
        queries,
        dashboard: new MonitoringDashboardService(
            prisma as never,
            cache as never,
            probes as never,
        ),
        insights: new MonitorInsightsService(prisma as never),
    };
}

describe('Monitoring protocol merge compatibility', () => {
    it('includes new protocols and filters blocked rows from every dashboard metric', async () => {
        const { dashboard, queries, tx } = fixture();
        const result = await dashboard.dashboard(
            'project',
            new QueryMonitoringDashboardDto(),
        );
        expect(result.distribution.protocols).toEqual([
            { type: 'HTTP', count: 1 },
            { type: 'DNS', count: 1 },
            { type: 'REDIS', count: 1 },
        ]);
        await dashboard.availability(
            'project',
            new QueryMonitoringAvailabilityDto(),
        );
        await dashboard.statusCodes(
            'project',
            new QueryMonitoringStatusCodesDto(),
        );
        expect(
            queries.filter((sql) => sql.includes('FROM check_logs')).length,
        ).toBeGreaterThanOrEqual(6);
        expect(tx.checkLog.count).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ evaluated: true }),
            }),
        );
    });

    it('filters blocked execution from insight aggregates and recent checks', async () => {
        const { insights, tx, queries } = fixture();
        const result = await insights.get(
            'project',
            'HTTP',
            new QueryMonitorInsightsDto(),
        );
        expect(result.metrics.uptimePercent).toBe(100);
        expect(result.metrics.avgLatencyMs).toBe(20);
        expect(
            queries.filter((sql) => sql.includes('FROM check_logs')),
        ).toHaveLength(2);
        expect(tx.checkLog.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ evaluated: true }),
            }),
        );
    });
});
