import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { ScheduledJobRegistry } from '../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../infra/scheduler/scheduled-jobs.constants';
import {
    lockObservationMonitor,
    capacityRestricted,
} from '../../shared/subscription/monitor-capacity.util';
import {
    NO_DATA_REASON,
    noDataTimeoutMs,
    observationAnchor,
} from '../state/no-data-policy';
import { AlertEventsService } from './alert-events.service';

@Injectable()
export class MonitorNoDataService implements OnModuleInit {
    private readonly logger = new Logger(MonitorNoDataService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly alerts: AlertEventsService,
        private readonly registry: ScheduledJobRegistry,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.monitorNoDataSweep,
            pattern: SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.monitorNoDataSweep],
            handler: () => this.sweep(),
        });
    }

    async sweep(at = new Date()): Promise<void> {
        let cursor = '';
        // Bound each run. Successfully marked rows leave the candidate set, so
        // subsequent ticks make progress even when the backlog exceeds 1,000.
        for (let page = 0; page < 10; page++) {
            const candidates = await this.prisma.$queryRaw<{ id: string }[]>`
                SELECT m.id FROM monitors m
                JOIN projects p ON p.id = m."projectId"
                JOIN organizations o ON o.id = m."organizationId"
                LEFT JOIN monitor_states s ON s."monitorId" = m.id
                WHERE m.id > ${cursor} AND m.enabled = true
                  AND m."deletedAt" IS NULL AND p."deletedAt" IS NULL AND o."deletedAt" IS NULL
                  AND (m."quotaGraceEndsAt" IS NULL OR m."quotaGraceEndsAt" > ${at})
                  AND s."noDataSince" IS NULL
                  AND GREATEST(m."createdAt", m."updatedAt", s."lastEffectiveObservationAt")
                    <= ${at} - GREATEST(3.0 * m."interval", 600.0) * INTERVAL '1 second'
                ORDER BY m.id LIMIT 100`;
            if (!candidates.length) break;
            for (const { id } of candidates) {
                cursor = id;
                try {
                    await this.mark(id, at);
                } catch {
                    // Keep other tenants progressing; the failed candidate is
                    // retried on the next sweep. Never log target credentials.
                    this.logger.error(`No-data sweep failed for monitor ${id}`);
                }
            }
            if (candidates.length < 100) break;
        }
    }

    async mark(monitorId: string, at: Date): Promise<boolean> {
        return this.prisma.$transaction(async (tx) => {
            await lockObservationMonitor(tx, monitorId);
            const monitor = await tx.monitor.findFirst({
                where: {
                    id: monitorId,
                    deletedAt: null,
                    project: {
                        deletedAt: null,
                        organization: { deletedAt: null },
                    },
                },
                include: { state: true },
            });
            if (
                !monitor ||
                !monitor.enabled ||
                capacityRestricted(monitor, at) ||
                monitor.state?.noDataSince ||
                at.getTime() - observationAnchor(monitor).getTime() <
                    noDataTimeoutMs(monitor.interval)
            )
                return false;
            await tx.monitorState.upsert({
                where: { monitorId },
                create: {
                    monitorId,
                    status: 'UNKNOWN',
                    noDataSince: at,
                    executionBlockedReason: NO_DATA_REASON,
                },
                update: {
                    status: 'UNKNOWN',
                    noDataSince: at,
                    executionBlockedReason: NO_DATA_REASON,
                },
            });
            await this.alerts.noData(tx, monitor, true, at, 'UNKNOWN');
            return true;
        });
    }
}
