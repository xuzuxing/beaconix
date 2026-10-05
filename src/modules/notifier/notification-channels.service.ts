import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { assertChannelConfig } from './channel-config';
import {
    CreateNotificationChannelDto,
    QueryNotificationLogsDto,
    UpdateNotificationChannelDto,
} from './dto';
import { NotificationChannelEntity, NotificationLogEntity } from './entities';

@Injectable()
export class NotificationChannelsService {
    constructor(private readonly prisma: PrismaService) {}

    async create(orgId: string, dto: CreateNotificationChannelDto) {
        assertChannelConfig(dto.type, dto.config);

        const channel = await this.prisma.notificationChannel.create({
            data: {
                organizationId: orgId,
                type: dto.type,
                name: dto.name,
                config: dto.config,
                enabled: dto.enabled ?? true,
            },
        });

        return new NotificationChannelEntity(channel);
    }

    async findAll(orgId: string) {
        const channels = await this.prisma.notificationChannel.findMany({
            where: { organizationId: orgId },
            orderBy: { createdAt: 'desc' },
        });

        return channels.map(
            (channel) => new NotificationChannelEntity(channel),
        );
    }

    async findOne(orgId: string, channelId: string) {
        const channel = await this.ensureChannelExists(orgId, channelId);
        return new NotificationChannelEntity(channel);
    }

    async update(
        orgId: string,
        channelId: string,
        dto: UpdateNotificationChannelDto,
    ) {
        const existing = await this.ensureChannelExists(orgId, channelId);

        const type = dto.type ?? existing.type;

        // A config must always be valid for the (possibly new) channel type.
        if (dto.config !== undefined) {
            assertChannelConfig(type, dto.config);
        } else if (dto.type !== undefined) {
            assertChannelConfig(type, existing.config);
        }

        const channel = await this.prisma.notificationChannel.update({
            where: { id: channelId },
            data: {
                type,
                name: dto.name,
                config: dto.config,
                enabled: dto.enabled,
            },
        });

        return new NotificationChannelEntity(channel);
    }

    async remove(orgId: string, channelId: string) {
        await this.ensureChannelExists(orgId, channelId);
        await this.prisma.notificationChannel.delete({
            where: { id: channelId },
        });
    }

    async findLogs(
        orgId: string,
        channelId: string,
        query: QueryNotificationLogsDto,
    ) {
        await this.ensureChannelExists(orgId, channelId);

        const page = query.page ?? 1;
        const limit = query.limit ?? 20;
        const skip = (page - 1) * limit;

        const where: Record<string, unknown> = { channelId };
        if (query.status) where.status = query.status;
        if (query.monitorId) where.monitorId = query.monitorId;

        const [logs, total] = await Promise.all([
            this.prisma.notificationLog.findMany({
                where,
                orderBy: { sentAt: 'desc' },
                skip,
                take: limit,
            }),
            this.prisma.notificationLog.count({ where }),
        ]);

        return {
            data: logs.map((log) => new NotificationLogEntity(log)),
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    private async ensureChannelExists(orgId: string, channelId: string) {
        const channel = await this.prisma.notificationChannel.findFirst({
            where: { id: channelId, organizationId: orgId },
        });

        if (!channel) {
            throw new NotFoundException('Notification channel not found');
        }

        return channel;
    }
}
