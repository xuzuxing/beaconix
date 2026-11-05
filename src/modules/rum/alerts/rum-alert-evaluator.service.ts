import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
    RumAlertIncidentStatus,
    RumAlertMetric,
    RumAlertScope,
    RumMetricKind,
} from '../../../generated/prisma/enums';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ScheduledJobRegistry } from '../../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../../infra/scheduler/scheduled-jobs.constants';
import { NotifierService } from '../../notifier/notifier.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { minuteBucket } from '../metrics/rum-metric-bucket';

const MAX_RULES_PER_SWEEP = 500;
type AlertRule = Prisma.RumAlertRuleGetPayload<object>;

@Injectable()
export class RumAlertEvaluatorService implements OnModuleInit {
    private readonly logger = new Logger(RumAlertEvaluatorService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly registry: ScheduledJobRegistry,
        private readonly notifications: NotificationsService,
        private readonly notifier: NotifierService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.rumAlertEvaluation,
            pattern: SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.rumAlertEvaluation],
            handler: () => this.handleEvaluation(),
        });
    }

    async handleEvaluation(): Promise<void> {
        await this.resolveUnavailableRules();
        let cursor: string | undefined;
        do {
            const rules = await this.prisma.rumAlertRule.findMany({
                where: {
                    enabled: true,
                    deletedAt: null,
                    app: {
                        enabled: true,
                        deletedAt: null,
                        organization: { deletedAt: null },
                        project: { deletedAt: null, status: 'ACTIVE' },
                    },
                },
                orderBy: { id: 'asc' },
                take: MAX_RULES_PER_SWEEP,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                select: { id: true },
            });
            for (const rule of rules) {
                try {
                    await this.evaluateRule(rule.id);
                } catch (error) {
                    this.logger.error(
                        `RUM alert evaluation failed for ${rule.id}`,
                        error as Error,
                    );
                }
            }
            cursor = rules.at(-1)?.id;
            if (rules.length < MAX_RULES_PER_SWEEP) break;
        } while (cursor);
        await this.deliverPendingNotifications();
    }

    private async resolveUnavailableRules(): Promise<void> {
        let cursor: string | undefined;
        do {
            const rules = await this.prisma.rumAlertRule.findMany({
                where: {
                    active: true,
                    OR: [
                        { enabled: false },
                        { deletedAt: { not: null } },
                        { app: { enabled: false } },
                        { app: { deletedAt: { not: null } } },
                        {
                            app: {
                                organization: { deletedAt: { not: null } },
                            },
                        },
                        {
                            app: {
                                project: {
                                    OR: [
                                        { deletedAt: { not: null } },
                                        { status: { not: 'ACTIVE' } },
                                    ],
                                },
                            },
                        },
                    ],
                },
                select: { id: true },
                orderBy: { id: 'asc' },
                take: MAX_RULES_PER_SWEEP,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            });
            for (const rule of rules) {
                const now = new Date();
                await this.prisma.$transaction([
                    this.prisma.rumAlertRule.updateMany({
                        where: { id: rule.id, active: true },
                        data: {
                            active: false,
                            lastValue: 0,
                            lastEvaluatedAt: now,
                        },
                    }),
                    this.prisma.rumAlertIncident.updateMany({
                        where: {
                            ruleId: rule.id,
                            status: RumAlertIncidentStatus.OPEN,
                        },
                        data: {
                            status: RumAlertIncidentStatus.RESOLVED,
                            value: 0,
                            resolvedAt: now,
                        },
                    }),
                ]);
            }
            cursor = rules.at(-1)?.id;
            if (rules.length < MAX_RULES_PER_SWEEP) break;
        } while (cursor);
    }

    async evaluateRule(ruleId: string): Promise<void> {
        await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`
                SELECT "id" FROM "rum_alert_rules"
                WHERE "id" = ${ruleId} FOR UPDATE
            `;
            const rule = await tx.rumAlertRule.findFirst({
                where: {
                    id: ruleId,
                    enabled: true,
                    deletedAt: null,
                    app: {
                        enabled: true,
                        deletedAt: null,
                        organization: { deletedAt: null },
                        project: { deletedAt: null, status: 'ACTIVE' },
                    },
                },
            });
            if (!rule) return;
            const now = new Date();
            const evaluation = await this.metricValue(tx, rule, now);
            const value = evaluation.value;
            if (evaluation.triggered) {
                const hits = rule.consecutiveHits + 1;
                const requiredWindows = Math.max(1, rule.confirmWindows);
                if (hits < requiredWindows) {
                    // De-bounce: keep counting consecutive matches without
                    // touching the incident state yet.
                    await tx.rumAlertRule.update({
                        where: { id: rule.id },
                        data: {
                            consecutiveHits: hits,
                            lastValue: value,
                            lastEvaluatedAt: now,
                        },
                    });
                    return;
                }
                const open = await tx.rumAlertIncident.findFirst({
                    where: {
                        ruleId: rule.id,
                        status: RumAlertIncidentStatus.OPEN,
                    },
                    orderBy: { startedAt: 'desc' },
                });
                if (open) {
                    await tx.rumAlertIncident.update({
                        where: { id: open.id },
                        data: { value, threshold: rule.threshold },
                    });
                } else {
                    await tx.rumAlertIncident.create({
                        data: {
                            ruleId: rule.id,
                            appId: rule.appId,
                            value,
                            threshold: rule.threshold,
                        },
                    });
                }
                await tx.rumAlertRule.update({
                    where: { id: rule.id },
                    data: {
                        active: true,
                        consecutiveHits: hits,
                        lastValue: value,
                        lastEvaluatedAt: now,
                    },
                });
                return;
            }

            if (rule.active) {
                await tx.rumAlertIncident.updateMany({
                    where: {
                        ruleId: rule.id,
                        status: RumAlertIncidentStatus.OPEN,
                    },
                    data: {
                        status: RumAlertIncidentStatus.RESOLVED,
                        value,
                        resolvedAt: now,
                    },
                });
            }
            await tx.rumAlertRule.update({
                where: { id: rule.id },
                data: {
                    active: false,
                    consecutiveHits: 0,
                    lastValue: value,
                    lastEvaluatedAt: now,
                },
            });
        });
    }

    private async metricValue(
        tx: Prisma.TransactionClient,
        rule: AlertRule,
        now: Date,
    ): Promise<{ value: number; triggered: boolean }> {
        const windowStart = minuteBucket(
            new Date(
                now.getTime() - Math.max(0, rule.windowMinutes - 1) * 60_000,
            ),
        );
        switch (rule.metric) {
            case RumAlertMetric.ERROR_COUNT: {
                const value = await this.errorCount(tx, rule, windowStart);
                return { value, triggered: value >= rule.threshold };
            }
            case RumAlertMetric.EVENT_COUNT: {
                const value = await this.eventCount(tx, rule, windowStart);
                return { value, triggered: value >= rule.threshold };
            }
            case RumAlertMetric.NEW_ERROR: {
                const value = await this.newErrorCount(tx, rule, windowStart);
                return {
                    value,
                    triggered: value >= Math.max(1, rule.threshold),
                };
            }
            case RumAlertMetric.ERROR_RATE: {
                const errors = await this.errorCount(tx, rule, windowStart);
                const events = await this.eventCount(tx, rule, windowStart);
                // Without a denominator the rate is undefined; never fire.
                if (events === 0) return { value: 0, triggered: false };
                const value = Math.round((errors * 100) / events);
                return { value, triggered: value >= rule.threshold };
            }
            case RumAlertMetric.SPIKE: {
                const previousStart = new Date(
                    windowStart.getTime() - rule.windowMinutes * 60_000,
                );
                const current = await this.errorCount(tx, rule, windowStart);
                const previous = await this.errorCount(
                    tx,
                    rule,
                    previousStart,
                    windowStart,
                );
                // threshold is the growth percentage over the previous window.
                const required = Math.ceil(
                    previous * (1 + rule.threshold / 100),
                );
                return {
                    value: current,
                    triggered: previous > 0 && current >= required,
                };
            }
            default:
                return { value: 0, triggered: false };
        }
    }

    private async errorCount(
        tx: Prisma.TransactionClient,
        rule: AlertRule,
        since: Date,
        before?: Date,
    ): Promise<number> {
        const range = {
            gte: since,
            ...(before ? { lt: before } : {}),
        };
        if (rule.scope === RumAlertScope.ERROR_GROUP && rule.groupId) {
            return tx.rumErrorOccurrence.count({
                where: {
                    appId: rule.appId,
                    groupId: rule.groupId,
                    receivedAt: range,
                },
            });
        }
        const result = await tx.rumMetricBucket.aggregate({
            where: {
                appId: rule.appId,
                kind: RumMetricKind.ERROR,
                name: '*',
                bucketStart: range,
            },
            _sum: { count: true },
        });
        return result._sum.count ?? 0;
    }

    private async eventCount(
        tx: Prisma.TransactionClient,
        rule: AlertRule,
        since: Date,
        before?: Date,
    ): Promise<number> {
        const range = {
            gte: since,
            ...(before ? { lt: before } : {}),
        };
        const result = await tx.rumMetricBucket.aggregate({
            where: {
                appId: rule.appId,
                kind: RumMetricKind.EVENT,
                name: rule.eventName || '*',
                bucketStart: range,
            },
            _sum: { count: true },
        });
        return result._sum.count ?? 0;
    }

    private async newErrorCount(
        tx: Prisma.TransactionClient,
        rule: AlertRule,
        since: Date,
    ): Promise<number> {
        if (rule.scope === RumAlertScope.ERROR_GROUP && rule.groupId) {
            const group = await tx.rumErrorGroup.findFirst({
                where: { id: rule.groupId, appId: rule.appId },
                select: { firstSeenAt: true },
            });
            return group && group.firstSeenAt >= since ? 1 : 0;
        }
        return tx.rumErrorGroup.count({
            where: { appId: rule.appId, firstSeenAt: { gte: since } },
        });
    }

    private async deliverPendingNotifications(): Promise<void> {
        const pending = await this.prisma.rumAlertIncident.findMany({
            where: {
                OR: [
                    {
                        status: RumAlertIncidentStatus.OPEN,
                        openedNotifiedAt: null,
                    },
                    {
                        status: RumAlertIncidentStatus.RESOLVED,
                        resolvedNotifiedAt: null,
                    },
                ],
            },
            include: { rule: true, app: true },
            orderBy: { startedAt: 'asc' },
            take: 100,
        });
        for (const incident of pending) {
            const active = incident.status === RumAlertIncidentStatus.OPEN;
            const phase = active ? 'OPEN' : 'RECOVERY';
            const metricLabel = this.metricLabel(incident.rule);
            if (
                incident.rule.silenceUntil &&
                incident.rule.silenceUntil.getTime() > Date.now()
            ) {
                // Silence window: the incident is still recorded, but the
                // notification is suppressed and never back-filled later.
                await this.prisma.rumAlertIncident.updateMany({
                    where: {
                        id: incident.id,
                        ...(active
                            ? { openedNotifiedAt: null }
                            : { resolvedNotifiedAt: null }),
                    },
                    data: active
                        ? { openedNotifiedAt: new Date() }
                        : { resolvedNotifiedAt: new Date() },
                });
                continue;
            }
            try {
                const recipients = await this.notifications.projectRecipients(
                    incident.app.projectId,
                );
                await this.notifications.publish({
                    eventKey: `rum-alert:${incident.id}:${phase}`,
                    recipients,
                    organizationId: incident.app.organizationId,
                    projectId: incident.app.projectId,
                    type: active ? 'RUM_ALERT' : 'RUM_RECOVERED',
                    title: active
                        ? `${incident.app.name}: ${metricLabel} threshold exceeded`
                        : `${incident.app.name}: ${metricLabel} recovered`,
                    body: active
                        ? `${incident.value} events in ${incident.rule.windowMinutes} minute(s), threshold ${incident.threshold}.`
                        : `${incident.value} events in ${incident.rule.windowMinutes} minute(s), below threshold ${incident.threshold}.`,
                    resourceType: 'RumApp',
                    resourceId: incident.app.id,
                    meta: {
                        rumAlertIncidentId: incident.id,
                        rumAlertRuleId: incident.rule.id,
                        metric: incident.rule.metric,
                        value: incident.value,
                        threshold: incident.threshold,
                    } satisfies Prisma.InputJsonValue,
                });
                const external = await this.notifier.notifyRumAlert({
                    appId: incident.app.id,
                    appName: incident.app.name,
                    organizationId: incident.app.organizationId,
                    metricLabel,
                    value: incident.value,
                    threshold: incident.threshold,
                    windowMinutes: incident.rule.windowMinutes,
                    active,
                    channelIds: incident.rule.channelIds,
                    occurredAt: active
                        ? incident.startedAt
                        : (incident.resolvedAt ?? new Date()),
                    idempotencyKey: `rum-alert:${incident.id}:${phase}`,
                });
                if (external.failed > 0)
                    throw new Error(
                        `${external.failed} RUM notification job(s) could not be enqueued`,
                    );
                await this.prisma.rumAlertIncident.updateMany({
                    where: {
                        id: incident.id,
                        ...(active
                            ? { openedNotifiedAt: null }
                            : { resolvedNotifiedAt: null }),
                    },
                    data: active
                        ? { openedNotifiedAt: new Date() }
                        : { resolvedNotifiedAt: new Date() },
                });
            } catch (error) {
                this.logger.warn(
                    `RUM alert notification failed for ${incident.id}: ${String(error)}`,
                );
            }
        }
    }

    private metricLabel(rule: AlertRule): string {
        const suffix =
            rule.scope === RumAlertScope.ERROR_GROUP ? ' (error group)' : '';
        switch (rule.metric) {
            case RumAlertMetric.EVENT_COUNT:
                return (
                    (rule.eventName && rule.eventName !== '*'
                        ? `event ${rule.eventName}`
                        : 'event count') + suffix
                );
            case RumAlertMetric.NEW_ERROR:
                return `new errors${suffix}`;
            case RumAlertMetric.ERROR_RATE:
                return `error rate %${suffix}`;
            case RumAlertMetric.SPIKE:
                return `error volume spike${suffix}`;
            case RumAlertMetric.ERROR_COUNT:
            default:
                return `error count${suffix}`;
        }
    }
}
