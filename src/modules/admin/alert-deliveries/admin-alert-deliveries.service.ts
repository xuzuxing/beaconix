import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { QueryAlertDeliveriesDto } from './query-alert-deliveries.dto';

@Injectable()
export class AdminAlertDeliveriesService {
    constructor(private readonly prisma: PrismaService) {}

    async findAll(query: QueryAlertDeliveriesDto) {
        const { page = 1, limit = 25 } = query;
        if (
            query.from &&
            query.to &&
            new Date(query.from) > new Date(query.to)
        ) {
            throw new BadRequestException('from must not be after to');
        }
        const where: Prisma.AlertDeliveryWhereInput = {
            status: query.status ?? 'FAILED',
            phase: query.phase,
            channelId: query.channelId,
            event: {
                organizationId: query.organizationId,
                projectId: query.projectId,
                monitorId: query.monitorId,
            },
            ...(query.from || query.to
                ? {
                      createdAt: {
                          ...(query.from ? { gte: new Date(query.from) } : {}),
                          ...(query.to ? { lte: new Date(query.to) } : {}),
                      },
                  }
                : {}),
        };
        // Explicit projection: payload, channel config and raw provider errors
        // can contain credentials and must never reach this endpoint.
        const [items, total] = await Promise.all([
            this.prisma.alertDelivery.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: (page - 1) * limit,
                take: limit,
                select: {
                    id: true,
                    eventId: true,
                    eventRevision: true,
                    phase: true,
                    channelId: true,
                    status: true,
                    attempts: true,
                    createdAt: true,
                    deliveredAt: true,
                    nextAttemptAt: true,
                    event: {
                        select: {
                            organizationId: true,
                            projectId: true,
                            monitorId: true,
                            monitorName: true,
                            kind: true,
                            status: true,
                            suppressedReason: true,
                        },
                    },
                },
            }),
            this.prisma.alertDelivery.count({ where }),
        ]);
        return { items, total, page, limit };
    }
}
