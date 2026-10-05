import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { MonitorStatus } from '../../generated/prisma/enums';
import type {
    MonitorModel,
    MonitorStateModel,
} from '../../generated/prisma/models';
import {
    MonitoringOverviewEntity,
    MonitoringOverviewMonitorEntity,
} from './entities';

const OVERVIEW_UPTIME_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_INCIDENT_LIMIT = 5;

type MonitorWithState = MonitorModel & { state?: MonitorStateModel | null };

@Injectable()
export class MonitoringService {
    constructor(private readonly prisma: PrismaService) {}

    async getOrganizationOverview(orgId: string) {
        const monitors = await this.prisma.monitor.findMany({
            where: { organizationId: orgId, deletedAt: null },
            include: { state: true },
            orderBy: { createdAt: 'asc' },
        });

        return this.buildOverview(monitors);
    }

    async getProjectOverview(projectId: string) {
        const monitors = await this.prisma.monitor.findMany({
            where: { projectId, deletedAt: null },
            include: { state: true },
            orderBy: { createdAt: 'asc' },
        });

        return this.buildOverview(monitors);
    }

    // -- Helpers ---------------------------------------------------------

    private async buildOverview(
        monitors: MonitorWithState[],
    ): Promise<MonitoringOverviewEntity> {
        const enabled = monitors.filter((monitor) => monitor.enabled).length;
        const counts = this.countByStatus(monitors);

        const latencyValues = monitors
            .map((monitor) => monitor.state?.lastLatency ?? null)
            .filter((value): value is number => value !== null);

        const avgLatency =
            latencyValues.length > 0
                ? Math.round(
                      latencyValues.reduce((sum, value) => sum + value, 0) /
                          latencyValues.length,
                  )
                : null;

        const recentIncidents = monitors
            .filter((monitor) => {
                const status = monitor.state?.status ?? MonitorStatus.UNKNOWN;
                return (
                    status === MonitorStatus.DOWN ||
                    status === MonitorStatus.DEGRADED
                );
            })
            .sort((a, b) => {
                const aTime = a.state?.updatedAt?.getTime() ?? 0;
                const bTime = b.state?.updatedAt?.getTime() ?? 0;
                return bTime - aTime;
            })
            .slice(0, RECENT_INCIDENT_LIMIT)
            .map(
                (monitor) =>
                    new MonitoringOverviewMonitorEntity({
                        id: monitor.id,
                        name: monitor.name,
                        target: monitor.target,
                        status: monitor.state?.status ?? MonitorStatus.UNKNOWN,
                        lastCheckAt: monitor.state?.lastCheckAt ?? null,
                        lastError: monitor.state?.lastError ?? null,
                    }),
            );

        const uptime = await this.buildUptimeSummary(monitors);

        const sslExpiringSoon = monitors.filter((monitor) => {
            const daysRemaining = monitor.state?.sslDaysRemaining ?? null;
            return (
                monitor.checkSsl &&
                daysRemaining !== null &&
                daysRemaining <= monitor.sslExpiryThreshold
            );
        }).length;

        return new MonitoringOverviewEntity({
            monitors: {
                total: monitors.length,
                enabled,
                paused: monitors.length - enabled,
            },
            byStatus: counts,
            recentIncidents,
            avgLatency,
            uptime,
            sslExpiringSoon,
        });
    }

    private countByStatus(monitors: MonitorWithState[]) {
        const counts = {
            UNKNOWN: 0,
            UP: 0,
            DEGRADED: 0,
            DOWN: 0,
            PAUSED: 0,
        };

        for (const monitor of monitors) {
            const status = monitor.state?.status ?? MonitorStatus.UNKNOWN;
            counts[status] += 1;
        }

        return counts;
    }

    private async buildUptimeSummary(monitors: MonitorWithState[]) {
        const monitorIds = monitors.map((monitor) => monitor.id);

        if (monitorIds.length === 0) {
            return { totalChecks: 0, successfulChecks: 0, uptimePercent: null };
        }

        const since = new Date(Date.now() - OVERVIEW_UPTIME_WINDOW_MS);
        const window = {
            monitorId: { in: monitorIds },
            checkedAt: { gte: since },
        };

        const [totalChecks, successfulChecks] = await Promise.all([
            this.prisma.checkLog.count({ where: window }),
            this.prisma.checkLog.count({
                where: { ...window, success: true },
            }),
        ]);

        return {
            totalChecks,
            successfulChecks,
            uptimePercent:
                totalChecks > 0
                    ? Math.round((successfulChecks / totalChecks) * 10000) / 100
                    : null,
        };
    }
}
