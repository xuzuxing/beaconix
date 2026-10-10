import {
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type {
    MonitorModel,
    MonitorStateModel,
} from '../../generated/prisma/models';
import type { CheckOutcome, DerivedState } from '../state/state.service';
import type { NotificationPayload } from '../notifier/notifier.types';

type Tx = Prisma.TransactionClient;
type Evidence = {
    reason: string;
    level: string;
    threshold?: number | null;
    actual?: number | null;
    unit?: string | null;
    message?: string | null;
    details?: Prisma.InputJsonValue;
};

@Injectable()
export class AlertEventsService {
    constructor(private readonly prisma: PrismaService) {}

    async retry(projectId: string, deliveryId: string) {
        const project = await this.prisma.project.findFirst({
            where: {
                id: projectId,
                deletedAt: null,
                organization: { deletedAt: null },
            },
            select: { id: true },
        });
        if (!project) throw new NotFoundException('Project not found');
        const result = await this.prisma.alertDelivery.updateMany({
            where: { id: deliveryId, status: 'FAILED', event: { projectId } },
            data: {
                status: 'PENDING',
                attempts: 0,
                leaseUntil: null,
                leaseToken: null,
                nextAttemptAt: new Date(),
                lastError: null,
            },
        });
        if (!result.count)
            throw new ConflictException(
                'Only failed deliveries in this project can be retried',
            );
        return { id: deliveryId, status: 'PENDING' };
    }
    async record(
        tx: Tx,
        monitor: MonitorModel,
        previous: MonitorStateModel | null,
        outcome: CheckOutcome,
        next: DerivedState & { connectivityFailCount: number },
    ) {
        let deliveries = 0;
        const serviceVerdict =
            outcome.serviceVerdict ??
            (outcome.ssl ? 'SUCCESS' : outcome.success ? 'SUCCESS' : 'FAILURE');
        const connectivity =
            serviceVerdict === 'NO_EVIDENCE'
                ? null
                : serviceVerdict === 'SUCCESS'
                  ? false
                  : next.connectivityFailCount >= monitor.failureThreshold
                    ? true
                    : null;
        deliveries += await this.reconcile(
            tx,
            monitor,
            'CONNECTIVITY',
            connectivity,
            {
                reason: outcome.failureReason ?? 'CHECK_FAILED',
                level: 'critical',
                threshold:
                    outcome.failureReason === 'TIMEOUT'
                        ? monitor.timeout
                        : outcome.failureReason === 'STATUS_MISMATCH'
                          ? monitor.expectedStatus
                          : null,
                actual:
                    outcome.failureReason === 'TIMEOUT'
                        ? outcome.latency
                        : outcome.failureReason === 'STATUS_MISMATCH'
                          ? outcome.statusCode
                          : null,
                unit:
                    outcome.failureReason === 'TIMEOUT'
                        ? 'ms'
                        : outcome.failureReason === 'STATUS_MISMATCH'
                          ? 'statusCode'
                          : null,
                message: outcome.error,
            },
            outcome,
            (previous?.status ?? 'UNKNOWN') !== 'UNKNOWN',
            next.status,
        );

        let availabilityAlertActive =
            previous?.availabilityAlertActive ?? false;
        if (monitor.availabilityEnabled) {
            const recent = await tx.checkLog.findMany({
                where: { monitorId: monitor.id },
                orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }],
                take: monitor.availabilityWindow ?? 10,
                select: { ruleMatched: true },
            });
            if (recent.length) {
                const actual =
                    (100 * recent.filter((log) => !log.ruleMatched).length) /
                    recent.length;
                let consecutive = 0;
                for (const log of recent) {
                    if (!log.ruleMatched) break;
                    consecutive++;
                }
                const threshold = monitor.availabilityThreshold ?? 90;
                const decision =
                    actual >= threshold
                        ? false
                        : consecutive >= monitor.failureThreshold
                          ? true
                          : null;
                deliveries += await this.reconcile(
                    tx,
                    monitor,
                    'AVAILABILITY',
                    decision,
                    {
                        reason: 'AVAILABILITY_LOW',
                        level: 'warning',
                        actual,
                        threshold,
                        unit: 'percent',
                        details: {
                            basis: 'RULE_HEALTHY',
                            sampleSize: recent.length,
                            window: monitor.availabilityWindow ?? 10,
                            consecutive,
                            rules: outcome.ruleEvidence ?? [],
                        },
                    },
                    outcome,
                    true,
                    next.status,
                );
                if (decision !== null) availabilityAlertActive = decision;
            }
        }
        if (
            monitor.checkSsl &&
            outcome.sslVerdict &&
            outcome.sslVerdict !== 'NO_EVIDENCE'
        ) {
            const invalid =
                outcome.sslVerdict === 'INVALID' ||
                outcome.sslVerdict === 'EXPIRED';
            const active = outcome.sslVerdict !== 'VALID';
            deliveries += await this.reconcile(
                tx,
                monitor,
                'SSL',
                active,
                {
                    reason: invalid ? 'SSL_INVALID' : 'SSL_EXPIRING',
                    level: invalid ? 'critical' : 'warning',
                    actual: outcome.ssl?.daysRemaining ?? null,
                    threshold: monitor.sslExpiryThreshold,
                    unit: 'days',
                    message: outcome.error,
                },
                outcome,
                true,
                next.status,
            );
        }
        return { deliveries, availabilityAlertActive };
    }

    private async reconcile(
        tx: Tx,
        monitor: MonitorModel,
        kind: string,
        active: boolean | null,
        evidence: Evidence,
        outcome: CheckOutcome,
        notify: boolean,
        status: string,
    ): Promise<number> {
        if (active === null) return 0;
        const existing = await tx.alertEvent.findFirst({
            where: { monitorId: monitor.id, kind, status: 'ongoing' },
        });
        if (!active && !existing) return 0;
        const at = new Date();
        const latestEvidence = {
            checkedAt: (outcome.checkedAt ?? at).toISOString(),
            actual: evidence.actual ?? null,
            details: evidence.details ?? {},
        } satisfies Prisma.InputJsonValue;
        if (active && existing) {
            await tx.alertEvent.update({
                where: { id: existing.id },
                data: { latestEvidence, suppressedReason: null },
            });
            if (!notify || existing.origin === 'BASELINE') return 0;
            const planned = await tx.alertDelivery.findMany({
                where: { eventId: existing.id, phase: 'OPEN' },
                select: { id: true },
                take: 1,
            });
            if (planned.length) return 0;
        }
        const event = active
            ? (existing ??
              (await tx.alertEvent.create({
                  data: {
                      monitorId: monitor.id,
                      projectId: monitor.projectId,
                      organizationId: monitor.organizationId,
                      monitorName: monitor.name,
                      target: monitor.target,
                      kind,
                      reason: evidence.reason,
                      level: evidence.level,
                      threshold: evidence.threshold,
                      actual: evidence.actual,
                      unit: evidence.unit,
                      message: evidence.message?.slice(0, 500),
                      latestEvidence,
                      startedAt: at,
                  },
              })))
            : await tx.alertEvent.update({
                  where: { id: existing!.id },
                  data: {
                      status: 'resolved',
                      resolvedAt: at,
                      suppressedReason: null,
                      durationSeconds: Math.max(
                          0,
                          Math.floor(
                              (at.getTime() - existing!.startedAt.getTime()) /
                                  1000,
                          ),
                      ),
                      lifecycleRevision: { increment: 1 },
                      latestEvidence,
                  },
              });
        if (active && !notify) return 0;
        const bindings =
            kind === 'CONNECTIVITY'
                ? []
                : await tx.monitorNotificationChannel.findMany({
                      where: { monitorId: monitor.id },
                  });
        const channels = await tx.notificationChannel.findMany({
            where: {
                organizationId: monitor.organizationId,
                enabled: true,
                ...(bindings.length
                    ? { id: { in: bindings.map((b) => b.channelId) } }
                    : {}),
            },
            select: { id: true },
        });
        const opened = active
            ? []
            : await tx.alertDelivery.findMany({
                  where: { eventId: event.id, phase: 'OPEN' },
                  select: { channelId: true },
              });
        const payload: NotificationPayload = {
            monitorId: monitor.id,
            monitorName: monitor.name,
            monitorType: monitor.type,
            target: monitor.target,
            organizationId: monitor.organizationId,
            previousStatus: active ? 'UP' : 'DOWN',
            status,
            event:
                kind === 'AVAILABILITY'
                    ? active
                        ? 'AVAILABILITY_ALERT'
                        : 'AVAILABILITY_RECOVERED'
                    : active
                      ? 'DOWN'
                      : 'RECOVER',
            failCount: 0,
            latency: outcome.latency,
            error: active ? (evidence.message ?? event.reason) : null,
            checkedAt: outcome.checkedAt ?? at,
            ...(kind === 'AVAILABILITY'
                ? {
                      availabilityPercent: evidence.actual ?? 0,
                      availabilityThreshold: evidence.threshold ?? 90,
                      availabilityWindow: monitor.availabilityWindow ?? 10,
                  }
                : {}),
        };
        for (const channel of channels) {
            if (!active && !opened.some((d) => d.channelId === channel.id))
                continue;
            await tx.alertDelivery.create({
                data: {
                    eventId: event.id,
                    eventRevision: event.lifecycleRevision,
                    phase: active ? 'OPEN' : 'RECOVERY',
                    channelId: channel.id,
                    payload: JSON.parse(
                        JSON.stringify(payload),
                    ) as Prisma.InputJsonValue,
                },
            });
        }
        return active
            ? channels.length
            : channels.filter((c) => opened.some((d) => d.channelId === c.id))
                  .length;
    }
}
