import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../infra/database/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { ScheduledJobRegistry } from '../../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../../infra/scheduler/scheduled-jobs.constants';
import { ProbeScope, ProbeStatus } from '../../../generated/prisma/enums';
import {
    SystemProbeAssignmentStore,
    SystemProbeAssignments,
} from './system-probe-assignment.store';
import { QuotaService } from '../../../shared/quota/quota.service';
import type { MonitorPolicy } from '../../../shared/quota/quota.service';

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
        private readonly registry: ScheduledJobRegistry,
        private readonly quotaService: QuotaService,
    ) {}

    async onModuleInit(): Promise<void> {
        this.registry.register({
            name: SCHEDULED_JOBS.systemProbeAssignmentRefresh,
            pattern:
                SCHEDULED_JOB_PATTERNS[
                    SCHEDULED_JOBS.systemProbeAssignmentRefresh
                ],
            handler: () => this.refreshAssignments(),
        });

        await this.rebalance();
    }

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
            select: {
                id: true,
                type: true,
                organizationId: true,
                tenantProbesOnly: true,
            },
        });

        // The plan decides how many system probes each monitor gets:
        // `maxProbesPerMonitor` sizes the automatic pool. 0 assigns none, which
        // keeps the verdict on local + tenant probes only.
        const policies = new Map<string, Promise<MonitorPolicy>>();
        const policyFor = (organizationId: string) => {
            const cached = policies.get(organizationId);
            if (cached) return cached;

            const pending = this.quotaService.getMonitorPolicy(organizationId);
            policies.set(organizationId, pending);
            return pending;
        };

        const desired: { id: string; probes: number }[] = [];
        for (const monitor of monitors) {
            // New protocols are local-only until the probe upgrade is implemented.
            if (monitor.type !== 'HTTP' && monitor.type !== 'TCP') continue;
            // Tenant-only judging: the system pool has nothing to run for it.
            if (monitor.tenantProbesOnly) continue;

            const policy = await policyFor(monitor.organizationId);
            if (policy.capacityRestrictedIds?.includes(monitor.id)) continue;
            const count = Math.max(0, policy.maxProbesPerMonitor ?? 0);
            if (count > 0) desired.push({ id: monitor.id, probes: count });
        }

        const assignments: SystemProbeAssignments = Object.fromEntries(
            probes.map((probe) => [probe.id, []]),
        );
        const probeLoad: Record<string, number> = Object.fromEntries(
            probes.map((probe) => [probe.id, 0]),
        );

        // Least-loaded first, so a monitor's N probes are spread across regions
        // instead of all landing on the same host.
        for (const monitor of desired) {
            const candidates = probes
                .filter(
                    (probe) =>
                        probe.maxTenants === null ||
                        probe.maxTenants === 0 ||
                        probeLoad[probe.id] < probe.maxTenants,
                )
                .sort((a, b) => probeLoad[a.id] - probeLoad[b.id]);

            for (const probe of candidates.slice(0, monitor.probes)) {
                assignments[probe.id].push(monitor.id);
                probeLoad[probe.id] += 1;
            }
        }

        await this.assignmentStore.set(assignments);

        this.logger.log(
            `System probe assignment refreshed: ${probes.length} probe(s), ${desired.length} monitor(s), ${Object.values(assignments).flat().length} assignment(s)`,
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

    async getAssignmentsForMonitors(monitorIds: string[]): Promise<string[]> {
        const wanted = new Set(monitorIds);
        const assignments = await this.loadAssignments();
        if (!assignments)
            throw new Error('System probe assignments unavailable');
        return Object.entries(assignments)
            .filter(([, ids]) => ids.some((id) => wanted.has(id)))
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
