import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ProbeScope, ProbeStatus } from '../../../generated/prisma/enums';
import {
    AdminMetricsOverviewEntity,
    AdminTenantMetricEntity,
} from './entities';

type GroupedCount = { _count: number };

@Injectable()
export class AdminMetricsService {
    constructor(private readonly prisma: PrismaService) {}

    async getOverview(): Promise<AdminMetricsOverviewEntity> {
        const [tenantMetrics, users, projects, probes, systemProbes] =
            await Promise.all([
                this.getTenantMetrics(),
                this.prisma.user.count(),
                this.prisma.project.count({ where: { deletedAt: null } }),
                this.prisma.probe.count(),
                this.prisma.probe.count({
                    where: { scope: ProbeScope.SYSTEM },
                }),
            ]);

        const sum = (selector: (metric: AdminTenantMetricEntity) => number) =>
            tenantMetrics.reduce(
                (total, metric) => total + selector(metric),
                0,
            );

        return new AdminMetricsOverviewEntity({
            tenants: {
                total: tenantMetrics.length,
                active: tenantMetrics.filter((metric) => metric.active).length,
                deleted: tenantMetrics.filter((metric) => !metric.active)
                    .length,
            },
            users,
            projects,
            monitors: {
                total: sum((metric) => metric.monitorCount),
                enabled: sum((metric) => metric.enabledMonitorCount),
            },
            probes: {
                total: probes,
                tenant: sum((metric) => metric.tenantProbeCount),
                system: systemProbes,
            },
            checkVolume: sum((metric) => metric.checkVolume),
            notificationVolume: sum((metric) => metric.notificationVolume),
            statusPages: sum((metric) => metric.statusPageCount),
            systemProbeUsage: sum((metric) => metric.systemProbeUsage),
        });
    }

    async getTenantMetrics(): Promise<AdminTenantMetricEntity[]> {
        const [
            organizations,
            monitors,
            probes,
            statusPages,
            checkVolumes,
            notificationVolumes,
            channels,
        ] = await Promise.all([
            this.prisma.organization.findMany({
                select: {
                    id: true,
                    name: true,
                    slug: true,
                    deletedAt: true,
                },
                orderBy: { createdAt: 'desc' },
            }),
            this.prisma.monitor.findMany({
                select: {
                    id: true,
                    organizationId: true,
                    enabled: true,
                    deletedAt: true,
                    probes: {
                        select: {
                            probe: {
                                select: {
                                    scope: true,
                                    enabled: true,
                                    status: true,
                                },
                            },
                        },
                    },
                },
            }),
            this.prisma.probe.findMany({
                select: { id: true, organizationId: true, scope: true },
            }),
            this.prisma.statusPage.findMany({
                select: { id: true, organizationId: true },
            }),
            this.prisma.checkLog.groupBy({
                by: ['monitorId'],
                _count: true,
            }),
            this.prisma.notificationLog.groupBy({
                by: ['channelId'],
                _count: true,
            }),
            this.prisma.notificationChannel.findMany({
                select: { id: true, organizationId: true },
            }),
        ]);

        const monitorOrg = new Map(
            monitors.map((monitor) => [monitor.id, monitor.organizationId]),
        );
        const channelOrg = new Map(
            channels.map((channel) => [channel.id, channel.organizationId]),
        );

        const monitorCount = new Map<string, number>();
        const enabledMonitorCount = new Map<string, number>();
        const tenantProbeCount = new Map<string, number>();
        const statusPageCount = new Map<string, number>();
        const checkVolume = new Map<string, number>();
        const notificationVolume = new Map<string, number>();
        const systemProbeUsage = new Map<string, number>();

        for (const monitor of monitors) {
            if (monitor.deletedAt === null) {
                monitorCount.set(
                    monitor.organizationId,
                    (monitorCount.get(monitor.organizationId) ?? 0) + 1,
                );
            }

            if (monitor.deletedAt === null && monitor.enabled) {
                enabledMonitorCount.set(
                    monitor.organizationId,
                    (enabledMonitorCount.get(monitor.organizationId) ?? 0) + 1,
                );
            }

            if (monitor.deletedAt === null && monitor.enabled) {
                const activeTenantProbes = monitor.probes.filter(
                    (binding) =>
                        binding.probe.scope === ProbeScope.TENANT &&
                        binding.probe.enabled &&
                        binding.probe.status === ProbeStatus.ONLINE,
                ).length;

                if (activeTenantProbes < 2) {
                    systemProbeUsage.set(
                        monitor.organizationId,
                        (systemProbeUsage.get(monitor.organizationId) ?? 0) + 1,
                    );
                }
            }
        }

        for (const probe of probes) {
            if (
                probe.organizationId !== null &&
                probe.scope === ProbeScope.TENANT
            ) {
                tenantProbeCount.set(
                    probe.organizationId,
                    (tenantProbeCount.get(probe.organizationId) ?? 0) + 1,
                );
            }
        }

        for (const page of statusPages) {
            statusPageCount.set(
                page.organizationId,
                (statusPageCount.get(page.organizationId) ?? 0) + 1,
            );
        }

        for (const row of checkVolumes as Array<
            GroupedCount & { monitorId: string }
        >) {
            const organizationId = monitorOrg.get(row.monitorId);
            if (!organizationId) continue;

            checkVolume.set(
                organizationId,
                (checkVolume.get(organizationId) ?? 0) + row._count,
            );
        }

        for (const row of notificationVolumes as Array<
            GroupedCount & { channelId: string }
        >) {
            const organizationId = channelOrg.get(row.channelId);
            if (!organizationId) continue;

            notificationVolume.set(
                organizationId,
                (notificationVolume.get(organizationId) ?? 0) + row._count,
            );
        }

        return organizations.map(
            (organization) =>
                new AdminTenantMetricEntity({
                    organizationId: organization.id,
                    name: organization.name,
                    slug: organization.slug,
                    active: organization.deletedAt === null,
                    monitorCount: monitorCount.get(organization.id) ?? 0,
                    enabledMonitorCount:
                        enabledMonitorCount.get(organization.id) ?? 0,
                    tenantProbeCount:
                        tenantProbeCount.get(organization.id) ?? 0,
                    systemProbeUsage:
                        systemProbeUsage.get(organization.id) ?? 0,
                    checkVolume: checkVolume.get(organization.id) ?? 0,
                    notificationVolume:
                        notificationVolume.get(organization.id) ?? 0,
                    statusPageCount: statusPageCount.get(organization.id) ?? 0,
                }),
        );
    }
}
