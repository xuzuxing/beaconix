import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../infra/database/prisma.service';
import { CheckSource, MonitorStatus } from '../../generated/prisma/enums';
import type {
    MonitorModel,
    MonitorStateModel,
    MonitorStateUpdateManyMutationInput,
} from '../../generated/prisma/models';
import { MonitorStateEntity } from './entities';
import type { SslCertificateInfo } from '../checker/checkers';
import type {
    CheckFailureKind,
    CheckMetadata,
} from '../checker/checkers/check-result';

/** A check outcome (local run or probe report) before it is folded into state. */
export interface CheckOutcome {
    revision?: number;
    evaluated?: boolean;
    failureKind?: CheckFailureKind | null;
    meta?: CheckMetadata;
    success: boolean;
    latency: number;
    error?: string | null;
    /** Where the result came from - persisted on the CheckLog row. */
    source?: CheckSource;
    checkedAt?: Date;
    ssl?: SslCertificateInfo | null;
    /**
     * Raw local outcome when it differs from the final verdict (probe reports
     * carry the local result alongside the aggregated one).
     */
    localSuccess?: boolean | null;
    /** True when a failing local check was rescued by a successful probe. */
    rescuedByProbe?: boolean;
    /** Actual HTTP status code, persisted on the CheckLog row. */
    statusCode?: number | null;
    /**
     * Rule-tree verdict for this check: matched means "abnormal". When absent,
     * falls back to `!success` so monitors without bound rules still behave as
     * before (a reachability failure counts as abnormal).
     */
    ruleMatched?: boolean;
    /** IDs of the rule groups that matched in this check. */
    ruleGroupIds?: string[];
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
        return this.prisma.$transaction(async (tx) => {
            // Serialize result folding with definition edits and other check results.
            // A parameterized row lock avoids touching Monitor.updatedAt on every run.
            await tx.$queryRaw`SELECT "id" FROM "monitors" WHERE "id" = ${monitorId} FOR UPDATE`;
            const monitor = await tx.monitor.findFirst({
                where: { id: monitorId, deletedAt: null },
                include: { state: true },
            });

            if (!monitor) {
                if (outcome.revision !== undefined) return null;
                throw new NotFoundException('Monitor not found');
            }
            if (
                !monitor.enabled ||
                (outcome.revision !== undefined &&
                    monitor.revision !== outcome.revision) ||
                (outcome.source !== CheckSource.PROBE &&
                    outcome.checkedAt &&
                    monitor.state?.lastLocalCheckAt &&
                    outcome.checkedAt < monitor.state.lastLocalCheckAt)
            ) {
                return null;
            }

            const previous: DerivedState = {
                status: monitor.state?.status ?? MonitorStatus.UNKNOWN,
                failCount: monitor.state?.failCount ?? 0,
            };

            const evaluated = outcome.evaluated !== false;
            const derived = evaluated
                ? deriveState(
                      previous,
                      outcome.success,
                      monitor.failureThreshold,
                  )
                : previous;

            const checkedAt =
                outcome.source === CheckSource.PROBE
                    ? new Date()
                    : (outcome.checkedAt ?? new Date());
            const error = outcome.success
                ? null
                : (outcome.error ?? 'Check failed');
            const source = outcome.source ?? CheckSource.LOCAL;
            const localSuccess = outcome.localSuccess ?? outcome.success;
            const rescuedByProbe = outcome.rescuedByProbe ?? false;
            const ruleMatched =
                evaluated && (outcome.ruleMatched ?? !outcome.success);
            const ruleGroupIds = outcome.ruleGroupIds ?? [];

            const stateValues = {
                status: derived.status,
                failCount: derived.failCount,
                lastCheckAt: evaluated ? checkedAt : undefined,
                executionBlockedReason: evaluated ? null : error,
                // The schedule only moves on local checks: a chatty probe must not
                // push the next local run out of reach.
                lastLocalCheckAt:
                    source === CheckSource.LOCAL ? checkedAt : undefined,
                lastError: evaluated ? error : undefined,
                lastLatency: evaluated ? outcome.latency : undefined,
                ...(outcome.ssl !== undefined
                    ? {
                          sslExpiresAt: outcome.ssl?.expiresAt ?? null,
                          sslDaysRemaining: outcome.ssl?.daysRemaining ?? null,
                          sslIssuer: outcome.ssl?.issuer ?? null,
                          sslSubject: outcome.ssl?.subject ?? null,
                      }
                    : {}),
            };

            await tx.checkLog.create({
                data: {
                    monitorId,
                    success: outcome.success,
                    localSuccess,
                    rescuedByProbe,
                    latency: outcome.latency,
                    error,
                    statusCode: outcome.statusCode ?? null,
                    ruleMatched,
                    ruleGroupIds,
                    source,
                    checkedAt,
                    revision: outcome.revision ?? monitor.revision,
                    evaluated,
                    failureKind: outcome.failureKind ?? null,
                    meta: outcome.meta ?? {},
                },
            });
            const state = await tx.monitorState.upsert({
                where: { monitorId },
                create: { monitorId, ...stateValues },
                update: stateValues,
            });

            const transition: MonitorTransition = {
                ...derived,
                previousStatus: previous.status,
                previousFailCount: previous.failCount,
                changed: derived.status !== previous.status,
            };

            return { monitor, state, transition };
        });
    }

    /** Marks `status` as the last status that was pushed to notification channels. */
    async markNotified(
        monitorId: string,
        status: MonitorStatus,
        revision?: number,
    ): Promise<void> {
        if (revision !== undefined) {
            await this.updateCurrentState(monitorId, revision, {
                lastNotifiedStatus: status,
            });
            return;
        }
        await this.prisma.monitorState.update({
            where: { monitorId },
            data: { lastNotifiedStatus: status },
        });
    }

    /** Remembers that the current SSL certificate alert was delivered. */
    async markSslNotified(
        monitorId: string,
        at = new Date(),
        revision?: number,
    ): Promise<void> {
        if (revision !== undefined) {
            await this.updateCurrentState(monitorId, revision, {
                sslLastNotifiedAt: at,
            });
            return;
        }
        await this.prisma.monitorState.update({
            where: { monitorId },
            data: { sslLastNotifiedAt: at },
        });
    }

    async claimAvailabilityAlert(
        monitorId: string,
        revision: number,
        active: boolean,
        checkedAt: Date | null,
    ): Promise<string | null> {
        return this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "monitors" WHERE "id" = ${monitorId} FOR UPDATE`;
            const current = await tx.monitor.findFirst({
                where: {
                    id: monitorId,
                    revision,
                    enabled: true,
                    deletedAt: null,
                },
                include: { state: true },
            });
            const state = current?.state;
            if (!state || state.lastCheckAt?.getTime() !== checkedAt?.getTime())
                return null;
            if (state.availabilityAlertActive === active) {
                return state.availabilityAlertPendingId;
            }
            const pendingId = randomUUID();
            await tx.monitorState.updateMany({
                where: { monitorId },
                data: {
                    availabilityAlertActive: active,
                    availabilityAlertPendingId: pendingId,
                    ...(active ? { lastAvailabilityAlertAt: new Date() } : {}),
                },
            });
            return pendingId;
        });
    }

    async completeAvailabilityAlert(
        monitorId: string,
        revision: number,
        active: boolean,
        pendingId: string,
    ): Promise<void> {
        await this.updateCurrentState(
            monitorId,
            revision,
            { availabilityAlertPendingId: null },
            {
                availabilityAlertActive: active,
                availabilityAlertPendingId: pendingId,
            },
        );
    }

    private async updateCurrentState(
        monitorId: string,
        revision: number,
        data: MonitorStateUpdateManyMutationInput,
        expected: {
            availabilityAlertActive?: boolean;
            lastCheckAt?: Date | null;
            availabilityAlertPendingId?: string | null;
        } = {},
    ): Promise<boolean> {
        return this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "monitors" WHERE "id" = ${monitorId} FOR UPDATE`;
            const current = await tx.monitor.findFirst({
                where: {
                    id: monitorId,
                    revision,
                    enabled: true,
                    deletedAt: null,
                },
                select: { id: true },
            });
            if (!current) return false;
            const changed = await tx.monitorState.updateMany({
                where: { monitorId, ...expected },
                data,
            });
            return changed.count > 0;
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
        const window = {
            monitorId,
            checkedAt: { gte: since },
            evaluated: true,
        };

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
            executionBlockedReason:
                monitor.state?.executionBlockedReason ?? null,
            status: monitor.state?.status ?? MonitorStatus.UNKNOWN,
            failCount: monitor.state?.failCount ?? 0,
            lastCheckAt: monitor.state?.lastCheckAt ?? null,
            lastLatency: monitor.state?.lastLatency ?? null,
            lastError: monitor.state?.lastError ?? null,
            lastNotifiedStatus: monitor.state?.lastNotifiedStatus ?? null,
            sslExpiresAt: monitor.state?.sslExpiresAt ?? null,
            sslDaysRemaining: monitor.state?.sslDaysRemaining ?? null,
            sslIssuer: monitor.state?.sslIssuer ?? null,
            sslSubject: monitor.state?.sslSubject ?? null,
            sslLastNotifiedAt: monitor.state?.sslLastNotifiedAt ?? null,
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
