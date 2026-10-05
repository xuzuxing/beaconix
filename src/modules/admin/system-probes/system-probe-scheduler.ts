import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ProbeScope, ProbeStatus } from '../../../generated/prisma/enums';
import {
    SystemProbeAssignmentStore,
    SystemProbeAssignments,
} from './system-probe-assignment.store';

@Injectable()
export class SystemProbeScheduler implements OnModuleInit {
    private readonly logger = new Logger(SystemProbeScheduler.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly assignmentStore: SystemProbeAssignmentStore,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.rebalance();
    }

    @Cron(CronExpression.EVERY_HOUR, {
        name: 'system-probe-assignment-refresh',
    })
    async refreshAssignments(): Promise<void> {
        await this.rebalance();
    }

    async rebalance(): Promise<SystemProbeAssignments> {
        const probes = await this.prisma.probe.findMany({
            where: {
                scope: ProbeScope.SYSTEM,
                enabled: true,
                status: ProbeStatus.ONLINE,
            },
            orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        });

        if (probes.length === 0) {
            await this.assignmentStore.clear();
            this.logger.log(
                'No online system probes available; assignments cleared',
            );
            return {};
        }

        const monitors = await this.prisma.monitor.findMany({
            where: { enabled: true, deletedAt: null },
            include: {
                probes: {
                    include: {
                        probe: {
                            select: {
                                id: true,
                                scope: true,
                                enabled: true,
                                status: true,
                            },
                        },
                    },
                },
            },
        });

        const needSystemProbe = monitors.filter((monitor) => {
            const activeTenantProbeCount = monitor.probes.filter(
                (binding) =>
                    binding.probe.scope === ProbeScope.TENANT &&
                    binding.probe.enabled &&
                    binding.probe.status === ProbeStatus.ONLINE,
            ).length;

            return activeTenantProbeCount < 2;
        });

        const assignments: SystemProbeAssignments = Object.fromEntries(
            probes.map((probe) => [probe.id, []]),
        );
        const probeLoad: Record<string, number> = Object.fromEntries(
            probes.map((probe) => [probe.id, 0]),
        );

        for (const monitor of needSystemProbe) {
            const available = probes.filter(
                (probe) =>
                    probe.maxTenants === null ||
                    probe.maxTenants === 0 ||
                    probeLoad[probe.id] < probe.maxTenants,
            );

            if (available.length === 0) continue;

            const selected = available.reduce((best, probe) =>
                probeLoad[probe.id] < probeLoad[best.id] ? probe : best,
            );

            assignments[selected.id].push(monitor.id);
            probeLoad[selected.id] += 1;
        }

        await this.assignmentStore.set(assignments);

        this.logger.log(
            `System probe assignment refreshed: ${probes.length} probe(s), ${Object.values(assignments).flat().length} monitor(s)`,
        );

        return assignments;
    }

    async getAssignedProbes(monitorId: string): Promise<string[]> {
        const assignments = await this.assignmentStore.get();
        if (!assignments) return [];

        return Object.entries(assignments)
            .filter(([, monitorIds]) => monitorIds.includes(monitorId))
            .map(([probeId]) => probeId);
    }

    async getAssignedMonitorIds(probeId: string): Promise<string[]> {
        const assignments = await this.assignmentStore.get();
        if (!assignments) return [];

        return assignments[probeId] ?? [];
    }
}
