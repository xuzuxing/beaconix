import { NotificationDb } from './notification-event';
import { toIsoString } from '../../common/utils/date.util';
import { NotificationEntity } from './entities';

export async function projectInvitationState(
    db: NotificationDb,
    notifications: NotificationEntity[],
): Promise<NotificationEntity[]> {
    const ids = notifications
        .filter(
            (notice) =>
                notice.resourceType === 'Invitation' && notice.resourceId,
        )
        .map((notice) => notice.resourceId!);
    if (!ids.length) return notifications;
    const invitations = await db.invitation.findMany({
        where: { id: { in: ids } },
        select: {
            id: true,
            status: true,
            expiresAt: true,
            organization: { select: { deletedAt: true } },
        },
    });
    const current = new Map(
        invitations.map((invitation) => [invitation.id, invitation]),
    );
    for (const notice of notifications) {
        if (notice.resourceType !== 'Invitation') continue;
        const invitation = current.get(notice.resourceId!);
        const meta =
            notice.meta &&
            typeof notice.meta === 'object' &&
            !Array.isArray(notice.meta)
                ? (notice.meta as Record<string, unknown>)
                : {};
        let status = invitation?.status ?? meta.invitationStatus ?? 'REVOKED';
        if (
            invitation?.organization.deletedAt ||
            (!invitation && status === 'PENDING')
        )
            status = 'REVOKED';
        else if (
            status === 'PENDING' &&
            invitation &&
            invitation.expiresAt <= new Date()
        )
            status = 'EXPIRED';
        notice.meta = {
            ...meta,
            invitationStatus: status,
            invitationExpiresAt: invitation
                ? toIsoString(invitation.expiresAt)
                : meta.invitationExpiresAt,
            actionable:
                !!invitation &&
                status === 'PENDING' &&
                notice.type === 'INVITATION_RECEIVED',
        };
    }
    return notifications;
}
