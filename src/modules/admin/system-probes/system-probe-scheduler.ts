import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../infra/database/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { ProbeScope, ProbeStatus } from '../../../generated/prisma/enums';
import {
    SystemProbeAssignmentStore,
    SystemProbeAssignments,
} from './system-probe-assignment.store';

/** Lock key/value guard around a recompute; see `rebalance()`. */
const ASSIGNMENT_LOCK_KEY = 'sys_probe:rebalance:lock';
const ASSIGNMENT_LOCK_TTL_SECONDS = 30;

@Injectable()
export class SystemProbeScheduler implements OnModuleInit {
    private readonly logger = new Logger(SystemProbeScheduler.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly assignmentStore: SystemProbeAssignmentStore,
        private readonly redisService: RedisService,
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

    /**
     * Recomputes the system probe assignment table.
     *
     * Triggers overlap constantly (probe heartbeats, probe/monitor CRUD, the
     * hourly job, a missing table), and every run publishes a full table - so two
     * concurrent runs used to overwrite each other with tables computed from
     * different snapshots. A short Redis lock serialises them; the instance that
     * loses simply reuses whatever is already published.
     */
    async rebalance(): Promise<SystemProbeAssignments> {
        const token = randomUUID();
        const acquired = await this.redisService.setIfAbsent(
            ASSIGNMENT_LOCK_KEY,
            token,
            ASSIGNMENT_LOCK_TTL_SECONDS,
        );

        if (!acquired) {
            this.logger.debug(
                'Rebalance already in progress; reusing the published assignments',
            );

            return (await this.assignmentStore.get()) ?? {};
        }

        try {
            return await this.computeAssignments();
        } finally {
            try {
                await this.redisService.releaseLock(ASSIGNMENT_LOCK_KEY, token);
            } catch (error) {
                this.logger.warn(
                    `Failed to release the rebalance lock: ${(error as Error).message}`,
                );
            }
        }
    }

    private async computeAssignments(): Promise<SystemProbeAssignments> {
        const probes = await this.prisma.probe.findMany({
            where: {
                scope: ProbeScope.SYSTEM,
                enabled: true,
                status: ProbeStatus.ONLINE,
            },
            orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        });

        if (probes.length === 0) {
            // Persist an empty table instead of deleting the key: readers rebuild
            // the table whenever it is missing, and with nothing to assign they
            // would trigger a full rescan on every read.
            await this.assignmentStore.set({});
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
        const assignments = await this.loadAssignments();
        if (!assignments) return [];

        return Object.entries(assignments)
            .filter(([, monitorIds]) => monitorIds.includes(monitorId))
            .map(([probeId]) => probeId);
    }

    async getAssignedMonitorIds(probeId: string): Promise<string[]> {
        const assignments = await this.loadAssignments();
        if (!assignments) return [];

        return assignments[probeId] ?? [];
    }

    /**
     * The assignment table is cached in Redis behind a TTL. Rebuild it only when
     * it is missing (expired TTL, first read after a restart) so that read paths
     * such as probe heartbeats never trigger a full rescan by themselves.
     */
    private async loadAssignments(): Promise<SystemProbeAssignments | null> {
        const assignments = await this.assignmentStore.get();

        if (assignments) return assignments;

        return this.rebalance();
    }
}
