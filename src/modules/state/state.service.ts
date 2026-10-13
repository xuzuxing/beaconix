import {
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
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
import { AlertEventsService } from '../alert-events/alert-events.service';
import type { Prisma } from '../../generated/prisma/client';
import { ProjectAccessService } from '../../common/authorization/project-access.service';
import type { AccessPrincipal } from '../../common/authorization/access.types';
import { monitoringProjection } from '../../common/authorization/monitoring-projection';
import type {
    CheckFailureKind,
    CheckMetadata,
} from '../checker/checkers/check-result';

/** A check outcome (local run or probe report) before it is folded into state. */
export interface CheckOutcome {
    configRevision?: number;
    observationId?: string;
    probeResultId?: string;
    serviceVerdict?: 'SUCCESS' | 'FAILURE' | 'NO_EVIDENCE';
    localServiceVerdict?: CheckOutcome['serviceVerdict'];
    sslVerdict?: 'VALID' | 'EXPIRING' | 'EXPIRED' | 'INVALID' | 'NO_EVIDENCE';
    failureReason?: string;
    ruleEvidence?: Prisma.InputJsonValue[];
    probeRoundWindowMs?: number;
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
    constructor(
        private readonly prisma: PrismaService,
        private readonly alerts: AlertEventsService,
        private readonly access: ProjectAccessService,
    ) {}

    /**
     * Persists a check outcome: appends the CheckLog entry and folds the result
     * into the monitor's companion state row, in a single transaction.
     */
    async record(monitorId: string, outcome: CheckOutcome) {
        return this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM monitors WHERE id = ${monitorId} FOR UPDATE`;
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

            if (!monitor) {
                if (outcome.revision !== undefined) return null;
                throw new NotFoundException('Monitor not found');
            }
            if (
                outcome.configRevision !== undefined &&
                outcome.configRevision !== monitor.configRevision
            ) {
                if (outcome.revision !== undefined) return null;
                throw new ConflictException(
                    'Monitor configuration changed; discard stale observation',
                );
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
                      {
                          ...previous,
                          status:
                              monitor.enabled &&
                              previous.status === MonitorStatus.PAUSED
                                  ? MonitorStatus.UNKNOWN
                                  : previous.status,
                      },
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
            const observationId = outcome.observationId ?? randomUUID();
            const duplicate = await tx.checkLog.findUnique({
                where: { observationId },
            });
            const lastProbe =
                source === CheckSource.PROBE && outcome.probeRoundWindowMs
                    ? await tx.checkLog.findFirst({
                          where: { monitorId, source: CheckSource.PROBE },
                          orderBy: { checkedAt: 'desc' },
                          select: { checkedAt: true },
                      })
                    : null;
            const sameRound =
                lastProbe &&
                checkedAt.getTime() - lastProbe.checkedAt.getTime() <
                    outcome.probeRoundWindowMs!;
            const apply =
                !duplicate &&
                !sameRound &&
                monitor.enabled &&
                (!monitor.state?.lastAppliedObservationAt ||
                    checkedAt > monitor.state.lastAppliedObservationAt);
            if (duplicate || sameRound) {
                if (outcome.probeResultId)
                    await tx.probeResult.update({
                        where: { id: outcome.probeResultId },
                        data: { appliedAt: new Date() },
                    });
                return {
                    monitor,
                    state: monitor.state!,
                    deliveries: 0,
                    transition: {
                        ...previous,
                        previousStatus: previous.status,
                        previousFailCount: previous.failCount,
                        changed: false,
                    },
                };
            }
            const serviceVerdict =
                outcome.serviceVerdict ??
                (outcome.ssl
                    ? 'SUCCESS'
                    : outcome.success
                      ? 'SUCCESS'
                      : 'FAILURE');
            const connectivityFailCount =
                serviceVerdict === 'SUCCESS'
                    ? 0
                    : (monitor.state?.connectivityFailCount ?? 0) +
                      (serviceVerdict === 'FAILURE' ? 1 : 0);

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
                connectivityFailCount: evaluated
                    ? connectivityFailCount
                    : undefined,
                lastAppliedObservationAt: evaluated ? checkedAt : undefined,
                lastAppliedObservationId: evaluated ? observationId : undefined,
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
                    monitorRefId: monitorId,
                    organizationId: monitor.organizationId,
                    projectId: monitor.projectId,
                    monitorType: monitor.type,
                    observationId,
                    configRevision: monitor.configRevision,
                    serviceVerdict,
                    localServiceVerdict:
                        outcome.localServiceVerdict ?? serviceVerdict,
                    sslVerdict: outcome.sslVerdict ?? null,
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
            const alertResult =
                apply && evaluated
                    ? await this.alerts.record(
                          tx,
                          monitor,
                          monitor.state,
                          outcome,
                          { ...derived, connectivityFailCount },
                      )
                    : {
                          deliveries: 0,
                          availabilityAlertActive:
                              monitor.state?.availabilityAlertActive ?? false,
                      };
            const state = apply
                ? await tx.monitorState.upsert({
                      where: { monitorId },
                      create: {
                          monitorId,
                          ...stateValues,
                          availabilityAlertActive:
                              alertResult.availabilityAlertActive,
                      },
                      update: {
                          ...stateValues,
                          availabilityAlertActive:
                              alertResult.availabilityAlertActive,
                      },
                  })
                : monitor.state!;
            if (outcome.probeResultId) {
                await tx.probeResult.update({
                    where: { id: outcome.probeResultId },
                    data: { appliedAt: new Date() },
                });
            }

            const transition: MonitorTransition = {
                ...(apply ? derived : previous),
                previousStatus: previous.status,
                previousFailCount: previous.failCount,
                changed: apply && derived.status !== previous.status,
            };

            return {
                monitor,
                state,
                transition,
                deliveries: alertResult.deliveries,
            };
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
    async getSummary(
        projectId: string,
        monitorId: string,
        principal: AccessPrincipal,
    ) {
        const access = await this.access.project(
            principal,
            projectId,
            'monitor.read',
        );
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

        return monitoringProjection(
            new MonitorStateEntity({
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
                        ? Math.round((successfulChecks / totalChecks) * 10000) /
                          100
                        : null,
                avgLatency:
                    averageLatency === null || averageLatency === undefined
                        ? null
                        : Math.round(averageLatency),
            }),
            access.effectiveRole,
        );
    }
}
