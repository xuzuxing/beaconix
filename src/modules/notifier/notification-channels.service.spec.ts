import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NotificationChannelsService } from './notification-channels.service';
import type { PrismaService } from '../../infra/database/prisma.service';

const channelRow = {
    id: 'channel-1',
    organizationId: 'org-1',
    type: 'FEISHU',
    name: 'Platform alerts',
    config: { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' },
    enabled: true,
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
};

function createService() {
    const prisma = {
        notificationChannel: {
            create: jest.fn(),
            findMany: jest.fn(),
            findFirst: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        },
        notificationLog: { findMany: jest.fn(), count: jest.fn() },
        $transaction: jest.fn(),
    };
    // Creates now run inside a transaction (quota count + insert together).
    prisma.$transaction.mockImplementation((callback) => callback(prisma));

    const quotaService = {
        assertCanCreate: jest.fn().mockResolvedValue(undefined),
        assertCanCreateInTransaction: jest.fn().mockResolvedValue(undefined),
    };

    const service = new NotificationChannelsService(
        prisma as unknown as PrismaService,
        quotaService as never,
    );

    return { service, prisma, quotaService };
}

describe('NotificationChannelsService', () => {
    it.each([
        'http://127.1/hook',
        'http://169.254.169.254/latest/meta-data',
        'http://[::ffff:127.0.0.1]/hook',
        'https://user:secret@example.com/hook',
        'https://example.com/hook#secret',
    ])(
        'rejects unsafe destinations on both create and update: %s',
        async (webhookUrl) => {
            const { service, prisma } = createService();
            prisma.notificationChannel.findFirst.mockResolvedValue(channelRow);
            await expect(
                service.create('org-1', {
                    type: 'FEISHU',
                    name: 'Unsafe',
                    config: { webhookUrl },
                }),
            ).rejects.toThrow(BadRequestException);
            await expect(
                service.update('org-1', channelRow.id, {
                    config: { webhookUrl },
                }),
            ).rejects.toThrow(BadRequestException);
            expect(prisma.notificationChannel.create).not.toHaveBeenCalled();
            expect(prisma.notificationChannel.update).not.toHaveBeenCalled();
        },
    );

    describe('create', () => {
        it('stores a valid channel config', async () => {
            const { service, prisma } = createService();
            prisma.notificationChannel.create.mockResolvedValue(channelRow);

            const result = await service.create('org-1', {
                type: 'FEISHU',
                name: 'Platform alerts',
                config: {
                    webhookUrl:
                        'https://open.feishu.cn/open-apis/bot/v2/hook/x',
                },
            });

            expect(prisma.notificationChannel.create).toHaveBeenCalledWith({
                data: {
                    organizationId: 'org-1',
                    type: 'FEISHU',
                    name: 'Platform alerts',
                    config: {
                        webhookUrl:
                            'https://open.feishu.cn/open-apis/bot/v2/hook/x',
                    },
                    enabled: true,
                },
            });
            expect(result.id).toBe('channel-1');
        });

        it('rejects a config that does not fit the channel type', async () => {
            const { service, prisma } = createService();

            await expect(
                service.create('org-1', {
                    type: 'EMAIL',
                    name: 'Email alerts',
                    config: { webhookUrl: 'https://example.com' },
                }),
            ).rejects.toThrow(BadRequestException);

            expect(prisma.notificationChannel.create).not.toHaveBeenCalled();
        });

        it('rejects a non-http webhook url', async () => {
            const { service } = createService();

            await expect(
                service.create('org-1', {
                    type: 'DINGTALK',
                    name: 'Ops',
                    config: { webhookUrl: 'ftp://example.com/hook' },
                }),
            ).rejects.toThrow(BadRequestException);
        });
    });

    describe('update', () => {
        it('re-validates the stored config when the type changes', async () => {
            const { service, prisma } = createService();
            prisma.notificationChannel.findFirst.mockResolvedValue(channelRow);

            await expect(
                service.update('org-1', 'channel-1', { type: 'EMAIL' }),
            ).rejects.toThrow(BadRequestException);
            expect(prisma.notificationChannel.update).not.toHaveBeenCalled();
        });

        it('updates the channel when the new config is valid', async () => {
            const { service, prisma } = createService();
            prisma.notificationChannel.findFirst.mockResolvedValue(channelRow);
            prisma.notificationChannel.update.mockResolvedValue({
                ...channelRow,
                enabled: false,
            });

            const result = await service.update('org-1', 'channel-1', {
                enabled: false,
            });

            expect(prisma.notificationChannel.update).toHaveBeenCalledWith({
                where: { id: 'channel-1' },
                data: {
                    type: 'FEISHU',
                    name: undefined,
                    config: undefined,
                    enabled: false,
                },
            });
            expect(result.enabled).toBe(false);
        });
    });

    describe('findLogs', () => {
        it('paginates the channel delivery attempts', async () => {
            const { service, prisma } = createService();
            prisma.notificationChannel.findFirst.mockResolvedValue(channelRow);
            prisma.notificationLog.findMany.mockResolvedValue([
                {
                    id: 'log-1',
                    monitorId: 'monitor-1',
                    channelId: 'channel-1',
                    status: 'FAILED',
                    error: 'HTTP 500',
                    sentAt: new Date('2026-03-05T12:00:00.000Z'),
                },
            ]);
            prisma.notificationLog.count.mockResolvedValue(1);

            const result = await service.findLogs('org-1', 'channel-1', {
                status: 'FAILED',
                page: 2,
                limit: 10,
            });

            expect(prisma.notificationLog.findMany).toHaveBeenCalledWith({
                where: { channelId: 'channel-1', status: 'FAILED' },
                orderBy: { sentAt: 'desc' },
                skip: 10,
                take: 10,
            });
            expect(result.meta).toEqual({
                total: 1,
                page: 2,
                limit: 10,
                totalPages: 1,
            });
            expect(result.data[0].status).toBe('FAILED');
        });
    });

    describe('tenant scoping', () => {
        it('throws when the channel is not in the organization', async () => {
            const { service, prisma } = createService();
            prisma.notificationChannel.findFirst.mockResolvedValue(null);

            await expect(service.findOne('org-1', 'channel-1')).rejects.toThrow(
                NotFoundException,
            );
        });

        it('deletes an existing channel', async () => {
            const { service, prisma } = createService();
            prisma.notificationChannel.findFirst.mockResolvedValue(channelRow);
            prisma.notificationChannel.delete.mockResolvedValue(channelRow);

            await service.remove('org-1', 'channel-1');

            expect(prisma.notificationChannel.delete).toHaveBeenCalledWith({
                where: { id: 'channel-1' },
            });
        });
    });
});
