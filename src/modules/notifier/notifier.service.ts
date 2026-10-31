import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { capacityRestricted } from '../../shared/subscription/monitor-capacity.util';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../infra/database/prisma.service';
import {
    MonitorStatus,
    NotificationChannelType,
    NotificationStatus,
} from '../../generated/prisma/enums';
import type {
    MonitorModel,
    MonitorStateModel,
    NotificationChannelModel,
} from '../../generated/prisma/models';
import type { MonitorTransition } from '../state/state.service';
import {
    DingtalkSender,
    EmailSender,
    FeishuSender,
    WechatSubscribeSender,
    WecomSender,
} from './senders';
import { toMonitorEvent } from './notifier.types';
import type {
    AvailabilityAlertInfo,
    AvailabilityAlertState,
    NotificationChannelSender,
    NotificationPayload,
} from './notifier.types';
import {
    MONITOR_AVAILABILITY_JOB,
    MONITOR_TRANSITION_JOB,
    NOTIFICATION_QUEUE,
} from './notifier.queue';
import type { NotificationJobData } from './notifier.queue';

/** Statuses that are worth telling humans about. */
const NOTIFIABLE_STATUSES: MonitorStatus[] = [
    MonitorStatus.UP,
    MonitorStatus.DOWN,
];

export interface NotificationResult {
    /** True when no job was enqueued (nothing to send, or nothing to say). */
    skipped: boolean;
    /** Number of channel delivery jobs enqueued. */
    sent: number;
    failed: number;
}

@Injectable()
export class NotifierService {
    private readonly logger = new Logger(NotifierService.name);
    private readonly senders: Record<string, NotificationChannelSender>;

    constructor(
        private readonly prisma: PrismaService,
        feishuSender: FeishuSender,
        wecomSender: WecomSender,
        dingtalkSender: DingtalkSender,
        wechatSubscribeSender: WechatSubscribeSender,
        emailSender: EmailSender,
        @InjectQueue(NOTIFICATION_QUEUE)
        private readonly notificationQueue: Queue<NotificationJobData>,
    ) {
        this.senders = {
            [NotificationChannelType.FEISHU]: feishuSender,
            [NotificationChannelType.WECOM]: wecomSender,
            [NotificationChannelType.DINGTALK]: dingtalkSender,
            [NotificationChannelType.WECHAT_SUBSCRIBE]: wechatSubscribeSender,
            [NotificationChannelType.EMAIL]: emailSender,
        };
    }

    /**
     * Decides whether a transition deserves an alert:
     * - PAUSED / UNKNOWN / DEGRADED states are never announced
     * - the first check only establishes a baseline
     * - DOWN is announced once per incident
     * - UP is announced only as a recovery after a delivered DOWN alert
     */
    static shouldNotify(
        transition: MonitorTransition,
        lastNotifiedStatus: MonitorStatus | null,
    ): boolean {
        if (!NOTIFIABLE_STATUSES.includes(transition.status)) return false;

        if (transition.previousStatus === MonitorStatus.UNKNOWN) {
            return false;
        }

        if (transition.status === MonitorStatus.DOWN) {
            return lastNotifiedStatus !== MonitorStatus.DOWN;
        }

        return (
            transition.status === MonitorStatus.UP &&
            lastNotifiedStatus === MonitorStatus.DOWN
        );
    }

    /**
     * Enqueues one delivery job per enabled channel of the monitor's
     * organization. The check pipeline returns immediately; actual sending,
     * NotificationLog writes and `lastNotifiedStatus` updates happen in the
     * queue processor.
     */
    async notifyTransition(
        monitor: MonitorModel,
        state: MonitorStateModel,
        transition: MonitorTransition,
    ): Promise<NotificationResult> {
        if (
            !NotifierService.shouldNotify(
                transition,
                state.lastNotifiedStatus ?? null,
            )
        ) {
            return { skipped: true, sent: 0, failed: 0 };
        }

        const channels = await this.prisma.notificationChannel.findMany({
            where: { organizationId: monitor.organizationId, enabled: true },
            orderBy: { createdAt: 'asc' },
        });

        // Without channels there is nothing to do, and nothing to remember:
        // once a channel is added the current status will be announced.
        if (channels.length === 0) {
            return { skipped: true, sent: 0, failed: 0 };
        }

        const payload = this.buildPayload(monitor, state, transition);
        const sslAlert = this.isSslAlert(state);

        const deliveries = await Promise.allSettled(
            channels.map((channel) =>
                this.notificationQueue.add(
                    MONITOR_TRANSITION_JOB,
                    {
                        channelId: channel.id,
                        payload,
                        transitionStatus: transition.status,
                        sslAlert,
                    },
                    {
                        attempts: 3,
                        backoff: { type: 'exponential', delay: 5000 },
                        removeOnComplete: true,
                        removeOnFail: 100,
                    },
                ),
            ),
        );

        const failed = deliveries.filter(
            (delivery) => delivery.status === 'rejected',
        ).length;

        for (const delivery of deliveries) {
            if (delivery.status === 'rejected') {
                this.logger.warn(
                    `Failed to enqueue notification job: ${(delivery.reason as Error).message}`,
                );
            }
        }

        return {
            skipped: false,
            sent: channels.length - failed,
            failed,
        };
    }

    /**
     * Sends a single channel delivery synchronously and records the attempt.
     * The queue processor calls this; it throws after recording a failure so
     * BullMQ can retry the job with backoff.
     */
    async deliver(
        channelId: string,
        payload: NotificationPayload,
    ): Promise<boolean> {
        if (payload.monitorRevision !== undefined) {
            const monitor = await this.prisma.monitor.findFirst({
                where: {
                    id: payload.monitorId,
                    revision: payload.monitorRevision,
                    organizationId: payload.organizationId,
                    enabled: true,
                    deletedAt: null,
                },
                select: { id: true, quotaGraceEndsAt: true },
            });
            if (!monitor || capacityRestricted(monitor)) return false;
        }
        const channel = await this.prisma.notificationChannel.findUnique({
            where: { id: channelId },
        });

        if (!channel) {
            throw new Error(`Notification channel ${channelId} not found`);
        }

        try {
            await this.dispatch(channel, payload);
            await this.writeLog(
                channel.id,
                payload.monitorId,
                NotificationStatus.SUCCESS,
                null,
            );
            return true;
        } catch (error) {
            const message = (error as Error).message;
            this.logger.warn(
                `Channel ${channel.id} (${channel.type}) failed for monitor ${payload.monitorId}: ${message}`,
            );
            await this.writeLog(
                channel.id,
                payload.monitorId,
                NotificationStatus.FAILED,
                message,
            );
            throw error;
        }
    }

    async deliverAlertDelivery(deliveryId: string): Promise<void> {
        const leaseToken = randomUUID();
        const row = await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM alert_deliveries WHERE id = ${deliveryId} FOR UPDATE`;
            const delivery = await tx.alertDelivery.findUnique({
                where: { id: deliveryId },
                include: { event: true },
            });
            if (
                !delivery ||
                ['SUCCESS', 'SKIPPED', 'FAILED'].includes(delivery.status)
            )
                return null;
            if (
                delivery.status === 'PENDING' &&
                delivery.nextAttemptAt > new Date()
            )
                return null;
            if (
                delivery.status === 'SENDING' &&
                delivery.leaseUntil &&
                delivery.leaseUntil > new Date()
            )
                return null;
            const channel = await tx.notificationChannel.findFirst({
                where: {
                    id: delivery.channelId,
                    organizationId: delivery.event.organizationId,
                    enabled: true,
                },
            });
            const monitor = await tx.monitor.findFirst({
                where: {
                    id: delivery.event.monitorId,
                    project: {
                        deletedAt: null,
                        organization: { deletedAt: null },
                    },
                },
            });
            if (delivery.phase === 'RECOVERY') {
                const opening = await tx.alertDelivery.findFirst({
                    where: {
                        eventId: delivery.eventId,
                        channelId: delivery.channelId,
                        phase: 'OPEN',
                    },
                });
                if (opening?.status === 'SENDING') {
                    await tx.alertDelivery.update({
                        where: { id: deliveryId },
                        data: {
                            status: 'PENDING',
                            leaseUntil: null,
                            nextAttemptAt: new Date(Date.now() + 5000),
                        },
                    });
                    return null;
                }
                const newer = await tx.alertEvent.findFirst({
                    where: {
                        monitorId: delivery.event.monitorId,
                        kind: delivery.event.kind,
                        status: 'ongoing',
                    },
                });
                if (opening?.status !== 'SUCCESS' || newer) {
                    await tx.alertDelivery.update({
                        where: { id: deliveryId },
                        data: {
                            status: 'SKIPPED',
                            leaseUntil: null,
                            lastError:
                                'No delivered opening or a newer incident is active',
                        },
                    });
                    return null;
                }
            }
            const planned = delivery.payload as unknown as NotificationPayload;
            const suppressed =
                !monitor ||
                !!monitor.deletedAt ||
                !monitor.enabled ||
                capacityRestricted(monitor) ||
                (planned.monitorRevision !== undefined &&
                    planned.monitorRevision !== monitor.revision) ||
                (planned.monitorConfigRevision !== undefined &&
                    planned.monitorConfigRevision !== monitor.configRevision) ||
                (delivery.event.kind === 'SSL' && !monitor.checkSsl) ||
                (delivery.event.kind === 'AVAILABILITY' &&
                    !monitor.availabilityEnabled);
            if (
                !channel ||
                suppressed ||
                delivery.event.suppressedReason ||
                (delivery.phase === 'OPEN' &&
                    delivery.event.status !== 'ongoing')
            ) {
                await tx.alertDelivery.update({
                    where: { id: deliveryId },
                    data: {
                        status: 'SKIPPED',
                        leaseUntil: null,
                        lastError: 'Channel or event no longer active',
                    },
                });
                return null;
            }
            await tx.alertDelivery.update({
                where: { id: deliveryId },
                data: {
                    status: 'SENDING',
                    attempts: { increment: 1 },
                    leaseToken,
                    leaseUntil: new Date(Date.now() + 120_000),
                },
            });
            return { delivery, channel };
        });
        if (!row) return;
        const { delivery, channel } = row;
        const payload = delivery.payload as unknown as NotificationPayload;
        payload.idempotencyKey = deliveryId;
        const renewal = setInterval(() => {
            void this.prisma.alertDelivery
                .updateMany({
                    where: {
                        id: deliveryId,
                        status: 'SENDING',
                        leaseToken,
                        leaseUntil: { gt: new Date() },
                    },
                    data: { leaseUntil: new Date(Date.now() + 120_000) },
                })
                .catch((error: unknown) =>
                    this.logger.warn(
                        `Delivery lease renewal failed: ${String(error)}`,
                    ),
                );
        }, 30_000);
        try {
            await this.dispatch(channel, payload);
            await this.prisma.$transaction(async (tx) => {
                // A slow sender can finish after the SQL lease was reclaimed.
                // Fence the acknowledgement before writing success evidence.
                const completed = await tx.alertDelivery.updateMany({
                    where: {
                        id: deliveryId,
                        status: 'SENDING',
                        leaseToken,
                        leaseUntil: { gt: new Date() },
                    },
                    data: {
                        status: 'SUCCESS',
                        deliveredAt: new Date(),
                        leaseUntil: null,
                        leaseToken: null,
                    },
                });
                if (!completed.count) return;
                await tx.notificationLog.create({
                    data: {
                        monitorId: delivery.event.monitorId,
                        channelId: channel.id,
                        eventId: delivery.eventId,
                        deliveryId,
                        phase: delivery.phase,
                        attempt: delivery.attempts + 1,
                        status: NotificationStatus.SUCCESS,
                    },
                });
                await tx.alertEvent.updateMany({
                    where: { id: delivery.eventId, firstNotifiedAt: null },
                    data: { firstNotifiedAt: new Date() },
                });
            });
        } catch (error) {
            await this.prisma.$transaction(async (tx) => {
                await tx.notificationLog.create({
                    data: {
                        monitorId: delivery.event.monitorId,
                        channelId: channel.id,
                        eventId: delivery.eventId,
                        deliveryId,
                        phase: delivery.phase,
                        attempt: delivery.attempts + 1,
                        status: NotificationStatus.FAILED,
                        error: String(error).slice(0, 500),
                    },
                });
                await tx.alertDelivery.updateMany({
                    where: { id: deliveryId, leaseToken, status: 'SENDING' },
                    data: {
                        status:
                            delivery.attempts + 1 >= 3 ? 'FAILED' : 'PENDING',
                        leaseUntil: null,
                        leaseToken: null,
                        lastError: String(error).slice(0, 500),
                        nextAttemptAt: new Date(
                            Date.now() + 5000 * 2 ** delivery.attempts,
                        ),
                    },
                });
            });
            throw error;
        } finally {
            clearInterval(renewal);
        }
    }

    /**
     * Sends a one-off "test notification" through a single channel. Never
     * touches monitor state and never writes a NotificationLog row.
     */
    async sendTestMessage(
        orgId: string,
        channelId: string,
    ): Promise<{ delivered: boolean; error: string | null }> {
        const channel = await this.prisma.notificationChannel.findFirst({
            where: { id: channelId, organizationId: orgId },
        });

        if (!channel) {
            throw new NotFoundException('Notification channel not found');
        }

        try {
            await this.dispatch(channel, this.buildTestPayload(orgId));
            return { delivered: true, error: null };
        } catch (error) {
            return { delivered: false, error: (error as Error).message };
        }
    }

    /**
     * Enqueues an availability alert for the monitor. Delivers to the channels
     * bound to the monitor; when the monitor has no binding at all, it falls
     * back to every enabled channel of the organization.
     */
    async notifyAvailabilityAlert(
        monitor: MonitorModel,
        state: AvailabilityAlertState,
        alert: AvailabilityAlertInfo,
    ): Promise<NotificationResult> {
        return this.enqueueAvailability(
            monitor,
            state,
            alert,
            'AVAILABILITY_ALERT',
        );
    }

    /** Enqueues an availability-recovered notice for the monitor. */
    async notifyAvailabilityRecovery(
        monitor: MonitorModel,
        state: AvailabilityAlertState,
        alert: AvailabilityAlertInfo,
    ): Promise<NotificationResult> {
        return this.enqueueAvailability(
            monitor,
            state,
            alert,
            'AVAILABILITY_RECOVERED',
        );
    }

    private async enqueueAvailability(
        monitor: MonitorModel,
        state: AvailabilityAlertState,
        alert: AvailabilityAlertInfo,
        event: 'AVAILABILITY_ALERT' | 'AVAILABILITY_RECOVERED',
    ): Promise<NotificationResult> {
        const channels = await this.resolveAlertChannels(monitor);

        if (channels.length === 0) {
            return { skipped: true, sent: 0, failed: 0 };
        }

        const payload: NotificationPayload = {
            monitorId: monitor.id,
            monitorRevision: monitor.revision,
            monitorName: monitor.name,
            monitorType: monitor.type,
            target: monitor.target,
            organizationId: monitor.organizationId,
            previousStatus: state.status,
            status: state.status,
            event,
            failCount: alert.consecutiveFailures ?? state.failCount,
            latency: state.lastLatency ?? null,
            error: state.lastError ?? null,
            checkedAt: state.lastCheckAt ?? new Date(),
            availabilityPercent: alert.availabilityPercent,
            availabilityThreshold: alert.threshold,
            availabilityWindow: alert.window,
            availabilitySampleSize: alert.sampleSize,
            test: alert.isTest,
        };

        return this.enqueuePayload(channels, payload, state.status);
    }

    /** Enqueues one delivery job per channel for the given payload. */
    private async enqueuePayload(
        channels: NotificationChannelModel[],
        payload: NotificationPayload,
        transitionStatus: MonitorStatus,
    ): Promise<NotificationResult> {
        const deliveries = await Promise.allSettled(
            channels.map((channel) =>
                this.notificationQueue.add(
                    MONITOR_AVAILABILITY_JOB,
                    {
                        channelId: channel.id,
                        payload,
                        transitionStatus,
                        sslAlert: false,
                    },
                    {
                        attempts: 3,
                        backoff: { type: 'exponential', delay: 5000 },
                        removeOnComplete: true,
                        removeOnFail: 100,
                    },
                ),
            ),
        );

        const failed = deliveries.filter(
            (delivery) => delivery.status === 'rejected',
        ).length;

        for (const delivery of deliveries) {
            if (delivery.status === 'rejected') {
                this.logger.warn(
                    `Failed to enqueue notification job: ${(delivery.reason as Error).message}`,
                );
            }
        }

        return {
            skipped: false,
            sent: channels.length - failed,
            failed,
        };
    }

    /**
     * Channels an alert should reach: the monitor's bound channels when any
     * binding exists (disabled ones are dropped), otherwise every enabled
     * channel of the organization.
     */
    private async resolveAlertChannels(
        monitor: MonitorModel,
    ): Promise<NotificationChannelModel[]> {
        const bindings = await this.prisma.monitorNotificationChannel.findMany({
            where: { monitorId: monitor.id },
            include: { channel: true },
        });

        if (bindings.length > 0) {
            return bindings
                .map((binding) => binding.channel)
                .filter((channel) => channel.enabled);
        }

        return this.prisma.notificationChannel.findMany({
            where: { organizationId: monitor.organizationId, enabled: true },
            orderBy: { createdAt: 'asc' },
        });
    }

    // -- Helpers ---------------------------------------------------------

    private async dispatch(
        channel: NotificationChannelModel,
        payload: NotificationPayload,
    ): Promise<void> {
        const sender = this.senders[channel.type];

        if (!sender) {
            throw new Error(`Unsupported channel type "${channel.type}"`);
        }

        await sender.send(channel, payload);
    }

    private async writeLog(
        channelId: string,
        monitorId: string,
        status: NotificationStatus,
        error: string | null,
    ): Promise<void> {
        try {
            await this.prisma.notificationLog.create({
                data: { channelId, monitorId, status, error },
            });
        } catch (logError) {
            this.logger.error(
                'Failed to write notification log',
                logError as Error,
            );
        }
    }

    private buildPayload(
        monitor: MonitorModel,
        state: MonitorStateModel,
        transition: MonitorTransition,
    ): NotificationPayload {
        return {
            monitorId: monitor.id,
            monitorRevision: monitor.revision,
            monitorName: monitor.name,
            monitorType: monitor.type,
            target: monitor.target,
            organizationId: monitor.organizationId,
            previousStatus: transition.previousStatus,
            status: transition.status,
            event: toMonitorEvent(transition.status),
            failCount: transition.failCount,
            latency: state.lastLatency ?? null,
            error: state.lastError ?? null,
            checkedAt: state.lastCheckAt ?? new Date(),
        };
    }

    private isSslAlert(state: MonitorStateModel): boolean {
        return (
            state.sslExpiresAt !== null &&
            state.lastError?.startsWith('SSL certificate') === true
        );
    }

    private buildTestPayload(orgId: string): NotificationPayload {
        return {
            monitorId: 'test-notification',
            monitorName: 'Beaconix test notification',
            monitorType: 'HTTP',
            target: 'https://example.com/health',
            organizationId: orgId,
            previousStatus: 'UP',
            status: 'DOWN',
            event: 'DOWN',
            failCount: 1,
            latency: 0,
            error: 'Test message - no action required',
            checkedAt: new Date(),
        };
    }
}
