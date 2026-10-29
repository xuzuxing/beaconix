import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
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
    ADMIN_NOTIFICATION_TYPES,
    NotificationAudience,
} from './notification-event';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationStreamService } from './notification-stream.service';
import { EmailTemplate, EmailPayloadMap } from '../email/email.types';
import { projectInvitationState } from './invitation-notification-state';
import { NotificationAccessService } from './notification-access.service';
import { ProjectAccessService } from '../../common/authorization/project-access.service';

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
        private readonly authorization: NotificationAccessService,
        private readonly access: ProjectAccessService,
    ) {}

    async publish(
        event: NotificationEvent,
        tx?: NotificationDb,
    ): Promise<void> {
        const persist = async (db: NotificationDb) => {
            const scope = await this.eventScope(event, db);
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
                const audience: NotificationAudience = {
                    ...scope,
                    userId: user.id,
                };
                if (!(await this.authorization.eligible(audience, db)))
                    continue;
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
                        accessScope: scope.accessScope,
                        organizationId: scope.organizationId ?? null,
                        projectId: scope.projectId ?? null,
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
                            audience: { ...audience },
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
                            ...(event.actionUrl
                                ? {
                                      actionUrl: event.actionUrl,
                                      actionLabel: event.actionLabel,
                                  }
                                : {}),
                        },
                        `${key}:email`,
                        db,
                        { ...audience, email: user.email },
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
        audience?: NotificationAudience,
    ): Promise<void> {
        const db = tx ?? this.prisma;
        if (!audience)
            throw new BadRequestException(
                'Explicit notification audience required',
            );
        const deliveryAudience = { ...audience, email: payload.to };
        await db.notificationDelivery.createMany({
            data: [
                {
                    dedupKey: deliveryKey(`email:${eventKey}`),
                    channel: 'EMAIL',
                    payload: JSON.parse(
                        JSON.stringify({
                            template,
                            data: payload,
                            audience: deliveryAudience,
                        }),
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
            accessScope: 'ACCOUNT',
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
            accessScope: 'ACCOUNT',
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
                projectId: true,
                createdById: true,
                assignedToId: true,
                watchers: { select: { userId: true } },
            },
        });
        if (!task) return [];
        const members = new Set(
            (
                await db.membership.findMany({
                    where: this.access.projectMemberFilter(
                        task.organizationId,
                        task.projectId,
                    ),
                    select: { userId: true },
                })
            ).map(({ userId }) => userId),
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
            (
                await db.membership.findMany({
                    where: this.access.projectMemberFilter(
                        project.organizationId,
                        projectId,
                    ),
                    select: { userId: true },
                })
            ).map(({ userId }) => userId),
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
        const where = await this.authorization.visibleWhere(userId);
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
            items: await projectInvitationState(
                this.prisma,
                notifications.map((n) => new NotificationEntity(n)),
            ),
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        };
    }

    async getUnreadCount(userId: string): Promise<{ count: number }> {
        await this.syncPendingInvitations(userId);
        return {
            count: await this.prisma.notification.count({
                where: {
                    ...(await this.authorization.visibleWhere(userId)),
                    isRead: false,
                },
            }),
        };
    }

    async findOne(
        userId: string,
        notificationId: string,
    ): Promise<NotificationEntity> {
        const notification = await this.prisma.notification.findFirst({
            where: {
                ...(await this.authorization.visibleWhere(userId)),
                id: notificationId,
            },
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
        return this.authorization.withWrite(userId, async (tx, where) => {
            const notification = await tx.notification.findFirst({
                where: { ...where, id: notificationId },
            });
            if (!notification)
                throw new NotFoundException('Notification not found');
            const updated = await tx.notification.update({
                where: { id: notificationId, AND: where },
                data: {
                    isRead: true,
                    readAt: notification.readAt ?? new Date(),
                },
            });
            return (
                await projectInvitationState(tx, [
                    new NotificationEntity(updated),
                ])
            )[0];
        });
    }

    async markAllAsRead(userId: string) {
        return this.authorization.withWrite(userId, async (tx, where) => {
            const { count } = await tx.notification.updateMany({
                where: { ...where, isRead: false },
                data: { isRead: true, readAt: new Date() },
            });
            return { updated: count };
        });
    }

    async remove(userId: string, notificationId: string) {
        await this.authorization.withWrite(userId, async (tx, where) => {
            const notification = await tx.notification.findFirst({
                where: { ...where, id: notificationId },
            });
            if (!notification)
                throw new NotFoundException('Notification not found');
            await tx.notification.delete({
                where: { id: notificationId, AND: where },
            });
        });
    }

    getStream(userId: string) {
        return this.streams.getStream(userId);
    }

    private async eventScope(
        event: NotificationEvent,
        db: NotificationDb,
    ): Promise<Omit<NotificationAudience, 'userId'>> {
        const meta =
            event.meta &&
            typeof event.meta === 'object' &&
            !Array.isArray(event.meta)
                ? (event.meta as Prisma.InputJsonObject)
                : {};
        if (
            event.accessScope === 'ACCOUNT' ||
            event.type === 'ORGANIZATION_DELETED'
        ) {
            return { accessScope: 'ACCOUNT' };
        }
        if (event.accessScope === 'ORGANIZATION' && event.organizationId) {
            return {
                accessScope: 'ORGANIZATION',
                organizationId: event.organizationId,
                ...(event.resourceType === 'MonitorCapacityCycle' &&
                event.resourceId
                    ? {
                          monitorCapacityCycleId: event.resourceId,
                          monitorCapacityStage: event.type,
                          ...(typeof meta.capacityStateKey === 'string'
                              ? {
                                    monitorCapacityStateKey:
                                        meta.capacityStateKey,
                                }
                              : {}),
                          ...(Array.isArray(meta.releasedMonitorIds)
                              ? {
                                    monitorCapacityReleasedIds:
                                        meta.releasedMonitorIds as string[],
                                }
                              : {}),
                          ...(typeof meta.deadline === 'string'
                              ? { monitorCapacityDeadline: meta.deadline }
                              : {}),
                      }
                    : {}),
                ...(ADMIN_NOTIFICATION_TYPES.includes(event.type)
                    ? { organizationRoles: ADMIN_ROLES }
                    : {}),
            };
        }
        if (
            event.resourceType === 'Invitation' &&
            event.type === 'INVITATION_RECEIVED'
        ) {
            const invitation = await db.invitation.findUnique({
                where: { id: event.resourceId },
                select: { id: true, email: true, organizationId: true },
            });
            if (!invitation)
                throw new BadRequestException('Invitation scope unavailable');
            return {
                accessScope: 'INVITATION',
                invitationId: invitation.id,
                organizationId: invitation.organizationId,
                email: invitation.email,
            };
        }
        let projectId = event.projectId;
        if (event.resourceType === 'Project') projectId = event.resourceId;
        if (!projectId && event.resourceType === 'Task') {
            projectId = (
                await db.task.findUnique({
                    where: { id: event.resourceId },
                    select: { projectId: true },
                })
            )?.projectId;
        }
        if (!projectId && event.resourceType === 'Sprint') {
            projectId = (
                await db.sprint.findUnique({
                    where: { id: event.resourceId },
                    select: { projectId: true },
                })
            )?.projectId;
        }
        if (!projectId && event.resourceType === 'Monitor') {
            projectId = (
                await db.monitor.findUnique({
                    where: { id: event.resourceId },
                    select: { projectId: true },
                })
            )?.projectId;
        }
        if (projectId && event.organizationId) {
            const project = await db.project.findFirst({
                where: { id: projectId, organizationId: event.organizationId },
                select: { id: true },
            });
            if (!project)
                throw new BadRequestException('Project scope mismatch');
            return {
                accessScope: 'PROJECT',
                organizationId: event.organizationId,
                projectId,
            };
        }
        if (
            event.organizationId &&
            ['Organization', 'Invitation'].includes(event.resourceType ?? '')
        ) {
            return {
                accessScope: 'ORGANIZATION',
                organizationId: event.organizationId,
            };
        }
        throw new BadRequestException('Explicit notification scope required');
    }
}
