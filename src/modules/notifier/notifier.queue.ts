import { MonitorStatus } from '../../generated/prisma/enums';
import type { NotificationPayload } from './notifier.types';

export const NOTIFICATION_QUEUE = 'notifications';
export const MONITOR_TRANSITION_JOB = 'monitor-transition';
export const MONITOR_AVAILABILITY_JOB = 'monitor-availability';
export const MONITOR_ALERT_EVENT_JOB = 'monitor-alert-event';

export interface NotificationJobData {
    deliveryId?: string;
    channelId: string;
    payload: NotificationPayload;
    transitionStatus: MonitorStatus;
    sslAlert: boolean;
}
