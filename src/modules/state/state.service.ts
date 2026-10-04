import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CheckSource, MonitorStatus } from '../../generated/prisma/enums';
import type {
    MonitorModel,
    MonitorStateModel,
} from '../../generated/prisma/models';
import { MonitorStateEntity } from './entities';

/** A check outcome (local run or probe report) before it is folded into state. */
export interface CheckOutcome {
    success: boolean;
    latency: number;
    error?: string | null;
    /** Where the result came from - persisted on the CheckLog row. */
    source?: string;
    checkedAt?: Date;
}

export interface DerivedState {
    status: MonitorStatus;
    failCount: number;
}

export interface MonitorTransition extends DerivedState {
    previousStatus: MonitorStatus;
    previousFailCount: number;
    /** True when the derived status differs from the previous one. */
    changed: boolean;
}

export type MonitorWithState = MonitorModel & {
    state?: MonitorStateModel | null;
};

/** Rolling window used by the uptime / latency summary. */
export const UPTIME_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Pure state machine: folds a check outcome into the next monitor status.
 *
 * - a success resets the failure streak and reports `UP`
 * - failures accumulate up to `failureThreshold`, reporting `DEGRADED` meanwhile
 * - a paused monitor keeps `PAUSED` (paused monitors are not scheduled)
 */
export function deriveState(
    previous: DerivedState,
    success: boolean,
    failureThreshold: number,
): DerivedState {
    if (previous.status === MonitorStatus.PAUSED) {
        return { status: MonitorStatus.PAUSED, failCount: previous.failCount };
    }

    if (success) {
        return { status: MonitorStatus.UP, failCount: 0 };
    }

    const failCount = previous.failCount + 1;

    return {
        status:
            failCount >= failureThreshold
                ? MonitorStatus.DOWN
                : MonitorStatus.DEGRADED,
        failCount,
    };
}

@Injectable()
export class StateService {
    constructor(private readonly prisma: PrismaService) {}

    /**
     * Persists a check outcome: appends the CheckLog entry and folds the result
     * into the monitor's companion state row, in a single transaction.
     */
    async record(monitorId: string, outcome: CheckOutcome) {
        const monitor = await this.prisma.monitor.findFirst({
            where: { id: monitorId, deletedAt: null },
            include: { state: true },
        });

        if (!monitor) {
            throw new NotFoundException('Monitor not found');
        }

        const previous: DerivedState = {
            status: monitor.state?.status ?? MonitorStatus.UNKNOWN,
            failCount: monitor.state?.failCount ?? 0,
        };

        const derived = deriveState(
            previous,
            outcome.success,
            monitor.failureThreshold,
        );

        const checkedAt = outcome.checkedAt ?? new Date();
        const error = outcome.success
            ? null
            : (outcome.error ?? 'Check failed');
        const source = outcome.source ?? CheckSource.LOCAL;

        const stateValues = {
            status: derived.status,
            failCount: derived.failCount,
            lastCheckAt: checkedAt,
            lastError: error,
            lastLatency: outcome.latency,
        };

        const [, state] = await this.prisma.$transaction([
            this.prisma.checkLog.create({
                data: {
                    monitorId,
                    success: outcome.success,
                    latency: outcome.latency,
                    error,
                    source,
                    checkedAt,
                },
            }),
            this.prisma.monitorState.upsert({
                where: { monitorId },
                create: { monitorId, ...stateValues },
                update: stateValues,
            }),
        ]);

        const transition: MonitorTransition = {
            ...derived,
            previousStatus: previous.status,
            previousFailCount: previous.failCount,
            changed: derived.status !== previous.status,
        };

        return { monitor, state, transition };
    }

    /** Marks `status` as the last status that was pushed to notification channels. */
    async markNotified(
        monitorId: string,
        status: MonitorStatus,
    ): Promise<void> {
        await this.prisma.monitorState.update({
            where: { monitorId },
            data: { lastNotifiedStatus: status },
        });
    }

    /** Current state of a monitor plus its trailing 24h uptime/latency summary. */
    async getSummary(projectId: string, monitorId: string) {
        const monitor = await this.prisma.monitor.findFirst({
            where: { id: monitorId, projectId, deletedAt: null },
            include: { state: true },
        });

        if (!monitor) {
            throw new NotFoundException('Monitor not found');
        }

        const since = new Date(Date.now() - UPTIME_WINDOW_MS);
        const window = { monitorId, checkedAt: { gte: since } };

        const [totalChecks, successfulChecks, latency] = await Promise.all([
            this.prisma.checkLog.count({ where: window }),
            this.prisma.checkLog.count({
                where: { ...window, success: true },
            }),
            this.prisma.checkLog.aggregate({
                where: window,
                _avg: { latency: true },
            }),
        ]);

        const averageLatency = latency._avg.latency;

        return new MonitorStateEntity({
            monitorId: monitor.id,
            name: monitor.name,
            target: monitor.target,
            type: monitor.type,
            status: monitor.state?.status ?? MonitorStatus.UNKNOWN,
            failCount: monitor.state?.failCount ?? 0,
            lastCheckAt: monitor.state?.lastCheckAt ?? null,
            lastLatency: monitor.state?.lastLatency ?? null,
            lastError: monitor.state?.lastError ?? null,
            lastNotifiedStatus: monitor.state?.lastNotifiedStatus ?? null,
            updatedAt: monitor.state?.updatedAt ?? null,
            uptimePercent:
                totalChecks > 0
                    ? Math.round((successfulChecks / totalChecks) * 10000) / 100
                    : null,
            avgLatency:
                averageLatency === null || averageLatency === undefined
                    ? null
                    : Math.round(averageLatency),
        });
    }
}
