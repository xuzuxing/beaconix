import { Injectable, NotFoundException } from '@nestjs/common';
import { toIsoString } from '../../common/utils/date.util';
import { createHash, randomUUID } from 'crypto';
import { Prisma } from '../../generated/prisma/client';
import type { MembershipRole } from '../../generated/prisma/enums';
import { PrismaService } from '../../infra/database/prisma.service';
import type { CreateNotificationDto } from './dto';
import { QueryNotificationsDto } from './dto';
import { NotificationEntity } from './entities';
import {
    NotificationDb,
    NotificationEvent,
    NotificationRecipient,
    ADMIN_ROLES,
} from './notification-event';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationStreamService } from './notification-stream.service';
import { EmailTemplate, EmailPayloadMap } from '../email/email.types';
import { projectInvitationState } from './invitation-notification-state';

function deliveryKey(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function safeMeta(
    value: Prisma.InputJsonValue | undefined,
): Prisma.InputJsonValue {
    if (Array.isArray(value))
        return value.map((item) => (item === null ? null : safeMeta(item)));
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .filter(
                    ([key]) =>
                        !/password|token|secret|recoveryCode|credential/i.test(
                            key,
                        ),
                )
                .map(([key, item]) => [
                    key,
                    item === null
                        ? null
                        : safeMeta(item as Prisma.InputJsonValue),
                ]),
        );
    }
    return value ?? {};
}

@Injectable()
export class NotificationsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly delivery: NotificationDeliveryService,
        private readonly streams: NotificationStreamService,
    ) {}

    async publish(
        event: NotificationEvent,
        tx?: NotificationDb,
    ): Promise<void> {
        const persist = async (db: NotificationDb) => {
            // First-wins allows mention/reply/assignment recipients to override
            // an ordinary watcher without receiving two messages for one event.
            const recipients = new Map<string, NotificationRecipient>();
            for (const entry of event.recipients) {
                const recipient =
                    typeof entry === 'string' ? { userId: entry } : entry;
                if (!recipient.userId || recipients.has(recipient.userId))
                    continue;
                if (!event.includeActor && recipient.userId === event.actorId)
                    continue;
                recipients.set(recipient.userId, recipient);
            }
            if (!recipients.size) return;

            const users = await db.user.findMany({
                where: {
                    id: { in: [...recipients.keys()] },
                    isActive: true,
                    deletedAt: null,
                    ...(event.organizationId && !event.allowOutsideOrg
                        ? {
                              memberships: {
                                  some: {
                                      organizationId: event.organizationId,
                                  },
                              },
                          }
                        : {}),
                },
                select: { id: true, email: true, emailVerified: true },
            });
            for (const user of users) {
                const recipient = recipients.get(user.id)!;
                const key = deliveryKey(`${event.eventKey}:user:${user.id}`);
                const sseKey = deliveryKey(`${key}:sse`);
                // Reserve the event before touching the inbox. The retained
                // intent is also its tombstone after the user dismisses it.
                const reserved = await db.notificationDelivery.createMany({
                    data: [{ dedupKey: sseKey, channel: 'SSE', payload: {} }],
                    skipDuplicates: true,
                });
                if (!reserved.count) continue;
                const notice = await db.notification.upsert({
                    where: { dedupKey: key },
                    create: {
                        dedupKey: key,
                        userId: user.id,
                        type: recipient.type ?? event.type,
                        title: recipient.title ?? event.title,
                        body: recipient.body ?? event.body ?? null,
                        resourceType: event.resourceType ?? null,
                        resourceId: event.resourceId ?? null,
                        meta: safeMeta({
                            ...(event.meta &&
                            typeof event.meta === 'object' &&
                            !Array.isArray(event.meta)
                                ? event.meta
                                : {}),
                            ...(event.organizationId
                                ? { organizationId: event.organizationId }
                                : {}),
                        }),
                    },
                    update: {},
                });
                await db.notificationDelivery.update({
                    where: { dedupKey: sseKey },
                    data: {
                        payload: {
                            notificationId: notice.id,
                            userId: user.id,
                            eventKey: event.eventKey,
                            audience: {
                                userId: user.id,
                                ...(event.organizationId
                                    ? { organizationId: event.organizationId }
                                    : {}),
                                allowOutsideOrg: event.allowOutsideOrg ?? false,
                            },
                        },
                    },
                });
                if ((recipient.email ?? event.email) && user.emailVerified) {
                    await this.enqueueEmail(
                        EmailTemplate.NOTIFICATION,
                        {
                            to: user.email,
                            title: recipient.title ?? event.title,
                            body: recipient.body ?? event.body ?? event.title,
                        },
                        `${key}:email`,
                        db,
                        {
                            userId: user.id,
                            organizationId: event.organizationId,
                            allowOutsideOrg: event.allowOutsideOrg,
                        },
                    );
                }
            }
        };
        if (tx) await persist(tx);
        else {
            await this.prisma.$transaction(persist);
            this.delivery.kick();
        }
    }

    async enqueueEmail<T extends EmailTemplate>(
        template: T,
        payload: EmailPayloadMap[T],
        eventKey: string,
        tx?: NotificationDb,
        audience?: {
            userId: string;
            organizationId?: string;
            allowOutsideOrg?: boolean;
        },
    ): Promise<void> {
        const db = tx ?? this.prisma;
        await db.notificationDelivery.createMany({
            data: [
                {
                    dedupKey: deliveryKey(`email:${eventKey}`),
                    channel: 'EMAIL',
                    payload: JSON.parse(
                        JSON.stringify({ template, data: payload, audience }),
                    ) as Prisma.InputJsonValue,
                },
            ],
            skipDuplicates: true,
        });
        if (!tx) this.delivery.kick();
    }

    async createAndEmit(
        userId: string,
        dto: CreateNotificationDto,
    ): Promise<void> {
        await this.publish({
            ...dto,
            eventKey: randomUUID(),
            recipients: [userId],
        });
    }

    async createAndEmitMany(
        userIds: string[],
        dto: CreateNotificationDto,
    ): Promise<void> {
        await this.publish({
            ...dto,
            eventKey: randomUUID(),
            recipients: userIds,
        });
    }

    async organizationRecipients(
        orgId: string,
        tx?: NotificationDb,
        roles?: MembershipRole[],
    ): Promise<string[]> {
        const members = await (tx ?? this.prisma).membership.findMany({
            where: {
                organizationId: orgId,
                ...(roles ? { role: { in: roles } } : {}),
            },
            select: { userId: true },
        });
        return [...new Set(members.map((member) => member.userId))];
    }

    async eventRecipients(
        eventKey: string,
        tx?: NotificationDb,
    ): Promise<string[]> {
        const deliveries = await (
            tx ?? this.prisma
        ).notificationDelivery.findMany({
            where: {
                channel: 'SSE',
                payload: { path: ['eventKey'], equals: eventKey },
            },
            select: { payload: true },
        });
        return [
            ...new Set(
                deliveries.flatMap(({ payload }) => {
                    const userId =
                        payload &&
                        typeof payload === 'object' &&
                        !Array.isArray(payload)
                            ? payload.userId
                            : null;
                    return typeof userId === 'string' ? [userId] : [];
                }),
            ),
        ];
    }

    async taskRecipients(
        taskId: string,
        tx?: NotificationDb,
    ): Promise<string[]> {
        const db = tx ?? this.prisma;
        const task = await db.task.findUnique({
            where: { id: taskId },
            select: {
                organizationId: true,
                createdById: true,
                assignedToId: true,
                watchers: { select: { userId: true } },
            },
        });
        if (!task) return [];
        const members = new Set(
            await this.organizationRecipients(task.organizationId, db),
        );
        return [
            ...new Set([
                task.createdById,
                task.assignedToId,
                ...task.watchers.map((w) => w.userId),
            ]),
        ].filter((id): id is string => !!id && members.has(id));
    }

    async projectRecipients(
        projectId: string,
        tx?: NotificationDb,
    ): Promise<string[]> {
        const db = tx ?? this.prisma;
        const project = await db.project.findUnique({
            where: { id: projectId },
            select: {
                organizationId: true,
                createdById: true,
                tasks: {
                    where: { deletedAt: null },
                    select: {
                        createdById: true,
                        assignedToId: true,
                        watchers: { select: { userId: true } },
                    },
                },
            },
        });
        if (!project) return [];
        const members = new Set(
            await this.organizationRecipients(project.organizationId, db),
        );
        const admins = await this.organizationRecipients(
            project.organizationId,
            db,
            ADMIN_ROLES,
        );
        const users = [
            project.createdById,
            ...admins,
            ...project.tasks.flatMap((task) => [
                task.createdById,
                task.assignedToId,
                ...task.watchers.map((w) => w.userId),
            ]),
        ];
        return [...new Set(users)].filter(
            (id): id is string => !!id && members.has(id),
        );
    }

    async syncPendingInvitations(
        userId: string,
        tx?: NotificationDb,
    ): Promise<void> {
        const db = tx ?? this.prisma;
        const user = await db.user.findFirst({
            where: {
                id: userId,
                deletedAt: null,
                isActive: true,
                emailVerified: true,
            },
            select: { email: true },
        });
        if (!user) return;
        const invitations = await db.invitation.findMany({
            where: {
                email: { equals: user.email, mode: 'insensitive' },
                status: 'PENDING',
                expiresAt: { gt: new Date() },
                organization: { deletedAt: null },
            },
            include: { organization: { select: { name: true } } },
        });
        for (const invitation of invitations) {
            await this.publish(
                {
                    eventKey: `invitation-received:${invitation.id}`,
                    recipients: [userId],
                    type: 'INVITATION_RECEIVED',
                    title: `You are invited to join ${invitation.organization.name}`,
                    body: `You have been invited as ${invitation.role}.`,
                    organizationId: invitation.organizationId,
                    allowOutsideOrg: true,
                    resourceType: 'Invitation',
                    resourceId: invitation.id,
                    meta: {
                        invitationStatus: 'PENDING',
                        invitationExpiresAt: toIsoString(invitation.expiresAt),
                        actionable: true,
                    },
                },
                tx,
            );
        }
    }

    async findAll(userId: string, query: QueryNotificationsDto) {
        await this.syncPendingInvitations(userId);
        const page = query.page ?? 1;
        const limit = query.limit ?? 20;
        const where: Prisma.NotificationWhereInput = { userId };
        if (query.isRead !== undefined) where.isRead = query.isRead;
        const [notifications, total] = await Promise.all([
            this.prisma.notification.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            this.prisma.notification.count({ where }),
        ]);
        return {
            data: await projectInvitationState(
                this.prisma,
                notifications.map((n) => new NotificationEntity(n)),
            ),
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        };
    }

    async getUnreadCount(userId: string): Promise<{ count: number }> {
        await this.syncPendingInvitations(userId);
        return {
            count: await this.prisma.notification.count({
                where: { userId, isRead: false },
            }),
        };
    }

    async findOne(
        userId: string,
        notificationId: string,
    ): Promise<NotificationEntity> {
        const notification = await this.prisma.notification.findFirst({
            where: { id: notificationId, userId },
        });
        if (!notification)
            throw new NotFoundException('Notification not found');
        return (
            await projectInvitationState(this.prisma, [
                new NotificationEntity(notification),
            ])
        )[0];
    }

    async markAsRead(userId: string, notificationId: string) {
        const notification = await this.prisma.notification.findFirst({
            where: { id: notificationId, userId },
        });
        if (!notification)
            throw new NotFoundException('Notification not found');
        const updated = await this.prisma.notification.update({
            where: { id: notificationId },
            data: { isRead: true, readAt: notification.readAt ?? new Date() },
        });
        return (
            await projectInvitationState(this.prisma, [
                new NotificationEntity(updated),
            ])
        )[0];
    }

    async markAllAsRead(userId: string) {
        const { count } = await this.prisma.notification.updateMany({
            where: { userId, isRead: false },
            data: { isRead: true, readAt: new Date() },
        });
        return { updated: count };
    }

    async remove(userId: string, notificationId: string) {
        const notification = await this.prisma.notification.findFirst({
            where: { id: notificationId, userId },
        });
        if (!notification)
            throw new NotFoundException('Notification not found');
        await this.prisma.notification.delete({
            where: { id: notificationId },
        });
    }

    getStream(userId: string) {
        return this.streams.getStream(userId);
    }
}
