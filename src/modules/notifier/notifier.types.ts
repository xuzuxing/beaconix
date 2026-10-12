import { MonitorStatus } from '../../generated/prisma/enums';
import type { NotificationChannelModel } from '../../generated/prisma/models';

/** The notification-worthy shape of a monitor status change. */
export type MonitorEvent =
    | 'DOWN'
    | 'DEGRADED'
    | 'RECOVER'
    | 'AVAILABILITY_ALERT'
    | 'AVAILABILITY_RECOVERED';

export interface NotificationPayload {
    idempotencyKey?: string;
    monitorId: string;
    /** Present on new local jobs; old queued payloads remain compatible. */
    monitorRevision?: number;
    monitorConfigRevision?: number;
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
    /** Queue and JSON payloads carry ISO strings instead of Date objects. */
    checkedAt: Date | string;
    /** Availability-alert only: recent availability percentage. */
    availabilityPercent?: number;
    /** Availability-alert only: configured threshold percentage. */
    availabilityThreshold?: number;
    /** Availability-alert only: configured window size (checks). */
    availabilityWindow?: number;
    /** Availability-alert only: number of checks the percentage is based on. */
    availabilitySampleSize?: number;
    /** True for a manually triggered test alert. */
    test?: boolean;
}

/** Input for an availability alert raised by the checker pipeline. */
export interface AvailabilityAlertInfo {
    availabilityPercent: number;
    threshold: number;
    window: number;
    sampleSize: number;
    /** Marks a manually triggered test alert. */
    isTest?: boolean;
    /** Consecutive rule-verdict failures shown in the alert message. */
    consecutiveFailures?: number;
}

/** The slice of monitor state an availability alert needs to render. */
export interface AvailabilityAlertState {
    status: MonitorStatus;
    failCount: number;
    lastLatency: number | null;
    lastError: string | null;
    lastCheckAt: Date | null;
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
