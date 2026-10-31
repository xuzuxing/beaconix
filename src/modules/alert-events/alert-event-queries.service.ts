import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { AccessDb } from '../../common/authorization/access-locks';
import type {
    AccessPrincipal,
    ProjectAccess,
} from '../../common/authorization/access.types';
import { ProjectAccessService } from '../../common/authorization/project-access.service';
import { allowsProjectAction } from '../../common/authorization/project-policy';
import { monitoringProjection } from '../../common/authorization/monitoring-projection';
import {
    AlertPageDto,
    QueryAlertEventsDto,
    QueryEventDeliveriesDto,
} from './dto/query-alert-events.dto';

// Never project raw evidence, diagnostic messages, payloads or provider errors.
const eventSelect = {
    id: true,
    projectId: true,
    monitorId: true,
    monitorName: true,
    target: true,
    kind: true,
    level: true,
    status: true,
    origin: true,
    suppressedReason: true,
    reason: true,
    threshold: true,
    actual: true,
    unit: true,
    startedAt: true,
    resolvedAt: true,
    durationSeconds: true,
    firstNotifiedAt: true,
    updatedAt: true,
} satisfies Prisma.AlertEventSelect;

@Injectable()
export class AlertEventQueriesService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ProjectAccessService,
    ) {}

    findAll(
        projectId: string,
        query: QueryAlertEventsDto,
        principal: AccessPrincipal,
    ) {
        const from = query.from ? new Date(query.from) : undefined;
        const to = query.to ? new Date(query.to) : undefined;
        // ISO week/ordinal dates pass IsDateString but Date cannot parse them.
        if (
            [from, to].some(
                (value) => value && !Number.isFinite(value.getTime()),
            )
        ) {
            throw new BadRequestException(
                'from and to must be parseable calendar dates',
            );
        }
        if (from && to && from > to) {
            throw new BadRequestException('from must not be after to');
        }
        return this.read(projectId, principal, async (tx, access) => {
            const where: Prisma.AlertEventWhereInput = {
                projectId,
                organizationId: access.organizationId,
                monitorId: query.monitorId,
                kind: query.kind,
                status: query.status,
                level: query.level,
                ...(from || to
                    ? {
                          startedAt: {
                              ...(from ? { gte: from } : {}),
                              ...(to ? { lte: to } : {}),
                          },
                      }
                    : {}),
            };
            const [events, total] = await Promise.all([
                tx.alertEvent.findMany({
                    where,
                    select: eventSelect,
                    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
                    skip: (query.page - 1) * query.limit,
                    take: query.limit,
                }),
                tx.alertEvent.count({ where }),
            ]);
            const active = await this.activeMonitors(
                tx,
                projectId,
                access.organizationId,
                events.map((e) => e.monitorId),
            );
            return {
                items: events.map((event) => ({
                    ...event,
                    monitorDeleted: !active.has(event.monitorId),
                })),
                total,
                page: query.page,
                limit: query.limit,
            };
        });
    }

    findOne(projectId: string, eventId: string, principal: AccessPrincipal) {
        return this.read(projectId, principal, async (tx, access) => {
            const event = await this.event(tx, access, eventId);
            const [active, deliverySummary] = await Promise.all([
                this.activeMonitors(tx, projectId, access.organizationId, [
                    event.monitorId,
                ]),
                tx.alertDelivery.groupBy({
                    by: ['status'],
                    where: { eventId: event.id },
                    _count: { _all: true },
                }),
            ]);
            return {
                ...event,
                monitorDeleted: !active.has(event.monitorId),
                deliverySummary: deliverySummary.map((row) => ({
                    status: row.status,
                    count: row._count._all,
                })),
                canRetryDeliveries: allowsProjectAction(access, 'alert.retry'),
            };
        });
    }

    deliveries(
        projectId: string,
        eventId: string,
        query: QueryEventDeliveriesDto,
        principal: AccessPrincipal,
    ) {
        return this.read(projectId, principal, async (tx, access) => {
            await this.event(tx, access, eventId);
            const where: Prisma.AlertDeliveryWhereInput = {
                eventId,
                status: query.status,
                phase: query.phase,
            };
            const [rows, total] = await Promise.all([
                tx.alertDelivery.findMany({
                    where,
                    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                    skip: (query.page - 1) * query.limit,
                    take: query.limit,
                    select: {
                        id: true,
                        eventId: true,
                        eventRevision: true,
                        channelId: true,
                        phase: true,
                        status: true,
                        attempts: true,
                        createdAt: true,
                        deliveredAt: true,
                        nextAttemptAt: true,
                    },
                }),
                tx.alertDelivery.count({ where }),
            ]);
            const channels = rows.length
                ? await tx.notificationChannel.findMany({
                      where: {
                          id: {
                              in: [
                                  ...new Set(rows.map((row) => row.channelId)),
                              ],
                          },
                          organizationId: access.organizationId,
                      },
                      select: {
                          id: true,
                          name: true,
                          type: true,
                          enabled: true,
                      },
                  })
                : [];
            const channelById = new Map(
                channels.map((channel) => [channel.id, channel]),
            );
            return {
                items: rows.map((row) => ({
                    ...row,
                    channel: channelById.get(row.channelId) ?? null,
                    canRetry:
                        row.status === 'FAILED' &&
                        allowsProjectAction(access, 'alert.retry'),
                })),
                total,
                page: query.page,
                limit: query.limit,
            };
        });
    }

    attempts(
        projectId: string,
        eventId: string,
        deliveryId: string,
        query: AlertPageDto,
        principal: AccessPrincipal,
    ) {
        return this.read(projectId, principal, async (tx, access) => {
            const event = await this.event(tx, access, eventId);
            const delivery = await tx.alertDelivery.findFirst({
                where: { id: deliveryId, eventId },
                select: { id: true, channelId: true },
            });
            if (!delivery)
                throw new NotFoundException('Alert delivery not found');
            const where: Prisma.NotificationLogWhereInput = {
                deliveryId,
                eventId,
                monitorId: event.monitorId,
                channelId: delivery.channelId,
            };
            const [items, total] = await Promise.all([
                tx.notificationLog.findMany({
                    where,
                    orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
                    skip: (query.page - 1) * query.limit,
                    take: query.limit,
                    select: {
                        id: true,
                        deliveryId: true,
                        eventId: true,
                        channelId: true,
                        phase: true,
                        attempt: true,
                        status: true,
                        sentAt: true,
                    },
                }),
                tx.notificationLog.count({ where }),
            ]);
            return { items, total, page: query.page, limit: query.limit };
        });
    }

    private read<T>(
        projectId: string,
        principal: AccessPrincipal,
        work: (tx: AccessDb, access: ProjectAccess) => Promise<T>,
    ) {
        // Authorization, rows and totals share one snapshot; the guard alone is
        // insufficient for direct service callers or membership changes.
        return this.prisma.$transaction(
            async (tx) => {
                const access = await this.access.project(
                    principal,
                    projectId,
                    'monitoring.read',
                    undefined,
                    tx,
                );
                return monitoringProjection(
                    await work(tx, access),
                    access.effectiveRole,
                );
            },
            { isolationLevel: 'RepeatableRead', timeout: 10000 },
        );
    }

    private async event(tx: AccessDb, access: ProjectAccess, eventId: string) {
        const event = await tx.alertEvent.findFirst({
            where: {
                id: eventId,
                projectId: access.projectId,
                organizationId: access.organizationId,
            },
            select: eventSelect,
        });
        if (!event) throw new NotFoundException('Alert event not found');
        return event;
    }

    private async activeMonitors(
        tx: AccessDb,
        projectId: string,
        organizationId: string,
        ids: string[],
    ) {
        if (!ids.length) return new Set<string>();
        const monitors = await tx.monitor.findMany({
            where: {
                id: { in: [...new Set(ids)] },
                projectId,
                organizationId,
                deletedAt: null,
            },
            select: { id: true },
        });
        return new Set(monitors.map((monitor) => monitor.id));
    }
}
