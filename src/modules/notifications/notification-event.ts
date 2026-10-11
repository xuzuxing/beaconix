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
}

export type NotificationDb = Prisma.TransactionClient;
export const ADMIN_ROLES: MembershipRole[] = ['OWNER', 'ADMIN'];
