import type {
    MembershipRole,
    NotificationType,
} from '../../generated/prisma/enums';
import type { Prisma } from '../../generated/prisma/client';
import type { CreateNotificationDto } from './dto';

export interface NotificationRecipient {
    userId: string;
    type?: NotificationType;
    title?: string;
    body?: string;
    email?: boolean;
}

export interface NotificationEvent extends CreateNotificationDto {
    eventKey: string;
    recipients: Array<string | NotificationRecipient>;
    organizationId?: string;
    actorId?: string;
    includeActor?: boolean;
    allowOutsideOrg?: boolean;
    email?: boolean;
    accessScope?: NotificationAudience['accessScope'];
    projectId?: string;
    actionUrl?: string;
    actionLabel?: string;
}

export interface NotificationAudience {
    accessScope: 'ACCOUNT' | 'INVITATION' | 'ORGANIZATION' | 'PROJECT';
    userId?: string;
    organizationId?: string;
    projectId?: string;
    invitationId?: string;
    email?: string;
    minimumRole?: 'MEMBER';
    organizationRoles?: MembershipRole[];
    monitorCapacityCycleId?: string;
    monitorCapacityStage?: string;
    monitorCapacityDeadline?: string;
    monitorCapacityStateKey?: string;
    monitorCapacityReleasedIds?: string[];
}

export type NotificationDb = Prisma.TransactionClient;
export const ADMIN_ROLES: MembershipRole[] = ['OWNER', 'ADMIN'];
export const ADMIN_NOTIFICATION_TYPES: NotificationType[] = [
    'API_KEY_CREATED',
    'API_KEY_REVOKED',
    'PROBE_ENROLLED',
    'PROBE_SECRET_ROTATED',
    'PROBE_CREDENTIAL_REVOKED',
    'PAYMENT_SUCCEEDED',
    'SUBSCRIPTION_ACTIVATED',
    'SUBSCRIPTION_RENEWED',
    'SUBSCRIPTION_EXPIRING',
    'SUBSCRIPTION_EXPIRED',
    'MONITOR_CAPACITY_GRACE_STARTED',
    'MONITOR_CAPACITY_GRACE_ENDING',
    'MONITOR_CAPACITY_LIMITED',
    'MONITOR_CAPACITY_RESTORED',
];
