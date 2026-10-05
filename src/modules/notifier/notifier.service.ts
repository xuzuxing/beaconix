import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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
import { StateService } from '../state/state.service';
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
    NotificationChannelSender,
    NotificationPayload,
} from './notifier.types';

/** Statuses that are worth telling humans about. */
const NOTIFIABLE_STATUSES: MonitorStatus[] = [
    MonitorStatus.UP,
    MonitorStatus.DOWN,
];

export interface NotificationResult {
    /** True when no channel was contacted (nothing to send, or nothing to say). */
    skipped: boolean;
    sent: number;
    failed: number;
}

@Injectable()
export class NotifierService {
    private readonly logger = new Logger(NotifierService.name);
    private readonly senders: Record<string, NotificationChannelSender>;

    constructor(
        private readonly prisma: PrismaService,
        private readonly stateService: StateService,
        feishuSender: FeishuSender,
        wecomSender: WecomSender,
        dingtalkSender: DingtalkSender,
        wechatSubscribeSender: WechatSubscribeSender,
        emailSender: EmailSender,
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
     * Fan-outs a status change to every enabled channel of the monitor's
     * organization, recording one NotificationLog row per attempt.
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

        const deliveries = await Promise.all(
            channels.map((channel) => this.deliver(channel, payload)),
        );

        const sent = deliveries.filter(Boolean).length;

        // Only remember the status once someone actually got the message,
        // so a transient channel outage does not swallow the alert.
        if (sent > 0) {
            await this.stateService.markNotified(monitor.id, transition.status);

            if (this.isSslAlert(state)) {
                await this.stateService.markSslNotified(monitor.id);
            }
        }

        return { skipped: false, sent, failed: deliveries.length - sent };
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

    // -- Helpers ---------------------------------------------------------

    private async deliver(
        channel: NotificationChannelModel,
        payload: NotificationPayload,
    ): Promise<boolean> {
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
            return false;
        }
    }

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
            monitorName: 'Beacon test notification',
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
