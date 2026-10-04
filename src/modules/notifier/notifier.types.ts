import type { NotificationChannelModel } from '../../generated/prisma/models';

/** The notification-worthy shape of a monitor status change. */
export type MonitorEvent = 'DOWN' | 'DEGRADED' | 'RECOVER';

export interface NotificationPayload {
    monitorId: string;
    monitorName: string;
    monitorType: string;
    target: string;
    organizationId: string;
    /** Status before the check that triggered this notification. */
    previousStatus: string;
    status: string;
    event: MonitorEvent;
    failCount: number;
    latency: number | null;
    error: string | null;
    checkedAt: Date;
}

/** Everything a channel implementation needs to know. */
export interface NotificationChannelSender {
    send(
        channel: NotificationChannelModel,
        payload: NotificationPayload,
    ): Promise<void>;
}

/** Maps a derived status onto the event name used in messages. */
export function toMonitorEvent(status: string): MonitorEvent {
    if (status === 'UP') return 'RECOVER';
    if (status === 'DEGRADED') return 'DEGRADED';
    return 'DOWN';
}
